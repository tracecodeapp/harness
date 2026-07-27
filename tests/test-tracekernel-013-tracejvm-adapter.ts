#!/usr/bin/env npx tsx

import type {
  RuntimeCommandEvent,
  RuntimeProjectCommandRequest,
  RuntimeProjectEngineLeaseAttachment,
  RuntimeProjectEngineLeaseController,
} from '../packages/harness-core/src/index';
import {
  createTraceJVMProjectRunner,
  type TraceJVMProjectClient,
} from '../packages/harness-java/src/tracejvm-project';
import { createBrowserProjectWorkspace } from '../packages/harness-browser/src/project';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const timings = {
  runtimeInitMs: 1,
  queueMs: 0,
  compileAndRunMs: 1,
  totalMs: 2,
};

function completed(
  overrides: Partial<Awaited<ReturnType<TraceJVMProjectClient['run']>>> = {}
): Awaited<ReturnType<TraceJVMProjectClient['run']>> {
  return {
    status: 'completed',
    exitCode: 0,
    stdout: '',
    stderr: '',
    timings,
    isolation: {
      status: 'clean',
      restored: [],
      taintReasons: [],
      hardBoundaryRecommended: false,
    },
    retirementRecommended: false,
    ...overrides,
  };
}

function request(
  source: 'compile' | 'run',
  args: string[],
  engineLease?: RuntimeProjectEngineLeaseController
): RuntimeProjectCommandRequest<'compile' | 'run'> {
  return {
    code: '',
    source,
    scriptPath: source === 'compile' ? 'src/example/Main.java' : 'example.Main',
    args,
    cwd: '/workspace/service',
    env: {},
    process: {
      pid: 42,
      ppid: 1,
      pgid: 42,
      sid: 42,
      descriptors: [0, 1, 2],
    },
    ...(engineLease ? { engineLease } : {}),
    project: {
      workspaceRoot: '/workspace',
      cwd: '/workspace/service',
      files: [
        {
          path: 'service/src/example/Main.java',
          contents: [
            'package example;',
            'public class Main {',
            '  public static void main(String[] args) {',
            '    System.out.println(args[0]);',
            '  }',
            '}',
          ].join('\n'),
        },
        {
          path: 'service/build/example/Main.class',
          contents: 'AQID',
          encoding: 'base64',
        },
        {
          path: 'service/lib/dependency.jar',
          contents: 'BAUG',
          encoding: 'base64',
        },
      ],
    },
  };
}

async function testKernelLeaseUsesFreshWorkers(): Promise<void> {
  let attachment: RuntimeProjectEngineLeaseAttachment | undefined;
  let attachCount = 0;
  const lease: RuntimeProjectEngineLeaseController = {
    attach(next) {
      attachCount += 1;
      attachment = next;
    },
  };
  let clientCount = 0;
  const terminated: number[] = [];
  const runner = createTraceJVMProjectRunner({
    createClient() {
      const id = ++clientCount;
      return {
        async compile(compileRequest) {
          assertCondition(
            compileRequest.sources[0]?.path === 'service/src/example/Main.java',
            `javac source was not resolved against cwd: ${JSON.stringify(compileRequest.sources)}`
          );
          assertCondition(
            compileRequest.classpath?.[0]?.path === 'dependency.jar',
            `javac classpath JAR was not mounted: ${JSON.stringify(compileRequest.classpath)}`
          );
          compileRequest.onStdout?.('compiler note\n');
          return {
            ...completed({ stdout: 'compiler note\n' }),
            program: {
              files: [{
                path: 'example/Main.class',
                content: new Uint8Array([7, 8, 9]),
              }],
            },
          };
        },
        async run(runRequest) {
          assertCondition(
            runRequest.program.files[0]?.path === 'example/Main.class',
            `java class directory was not mounted at its classpath root: ${JSON.stringify(runRequest.program)}`
          );
          assertCondition(
            runRequest.classpath?.[0]?.path === 'dependency.jar',
            `java dependency JAR was not mounted: ${JSON.stringify(runRequest.classpath)}`
          );
          assertCondition(
            runRequest.mainClass === 'example.Main' &&
              runRequest.args?.[0] === 'argument' &&
              runRequest.systemProperties?.mode === 'test',
            `java process inputs changed: ${JSON.stringify(runRequest)}`
          );
          return completed({ stdout: 'argument\n' });
        },
        terminate() {
          terminated.push(id);
        },
      };
    },
  });

  const events: RuntimeCommandEvent[] = [];
  const compileRequest = request('compile', [
    '-d',
    'build',
    '-cp',
    'lib/dependency.jar',
    'src/example/Main.java',
  ], lease);
  compileRequest.onEvent = (event) => events.push(event);
  const compile = await runner(compileRequest);
  assertCondition(
    Boolean(
      compile.files?.[0] &&
      'contents' in compile.files[0] &&
      compile.files[0].path === 'service/build/example/Main.class' &&
      compile.files[0].encoding === 'base64' &&
      compile.files[0].contents === 'BwgJ'
    ),
    `javac artifacts were not returned as a TKFS diff: ${JSON.stringify(compile.files)}`
  );
  assertCondition(
    events.some(
      (event) => event.type === 'output' && event.data === 'compiler note\n'
    ),
    'compiler output was not streamed through the kernel command bridge'
  );

  const runRequest = request('run', ['argument'], lease);
  runRequest.options = {
    classpath: 'build:lib/dependency.jar',
    systemProperties: { mode: 'test' },
  };
  const run = await runner(runRequest);
  assertCondition(
    run.exitCode === 0 && run.stdout === 'argument\n',
    `TraceJVM run result changed: ${JSON.stringify(run)}`
  );
  assertCondition(
    attachCount === 1,
    `one kernel PID must attach one coordinator, observed ${attachCount}`
  );
  assertCondition(
    clientCount === 2 && terminated.join(',') === '1,2',
    `javac and java must use fresh, hard-retired Workers: ${JSON.stringify({
      clientCount,
      terminated,
    })}`
  );
  assertCondition(
    attachment?.revalidate === undefined,
    'TraceJVM must not claim mutable Worker revalidation before reset proof exists'
  );
  await attachment?.release({ kind: 'destroy', reason: 'unvalidated' });
}

async function testCancellationHardRetiresWorker(): Promise<void> {
  let terminateCount = 0;
  let rejectRun: ((error: Error) => void) | undefined;
  const runner = createTraceJVMProjectRunner({
    createClient() {
      return {
        async compile() {
          throw new Error('compile should not run');
        },
        run() {
          return new Promise((_, reject) => {
            rejectRun = reject;
          });
        },
        terminate() {
          terminateCount += 1;
          rejectRun?.(new Error('worker terminated'));
        },
      };
    },
  });
  const controller = new AbortController();
  const runRequest = request('run', []);
  runRequest.signal = controller.signal;
  const operation = runner(runRequest);
  await Promise.resolve();
  controller.abort({ signal: 'SIGINT', source: 'test' });
  const result = await operation;
  assertCondition(
    result.exitCode === 130 &&
      result.handledSignal === 'SIGINT' &&
      terminateCount >= 1,
    `SIGINT did not hard-retire TraceJVM: ${JSON.stringify({
      result,
      terminateCount,
    })}`
  );
}

async function testUnsupportedBoundaryIsExplicit(): Promise<void> {
  let clientCount = 0;
  const runner = createTraceJVMProjectRunner({
    createClient() {
      clientCount += 1;
      throw new Error('unsupported snapshots must not allocate a VM');
    },
  });
  const unsupported = request('run', []);
  unsupported.project.symlinks = [{
    path: 'alias.class',
    symlink: true,
    target: 'build/example/Main.class',
  }];
  const result = await runner(unsupported);
  assertCondition(
    result.exitCode === 2 &&
      result.error?.code === 'ENOTSUP' &&
      result.error.syscall === 'materialize' &&
      clientCount === 0,
    `unsupported TraceJVM filesystem semantics were not explicit: ${JSON.stringify(result)}`
  );
}

async function testBrowserWorkspaceCommitsArtifactsToTKFS(): Promise<void> {
  let clientCount = 0;
  const workspace = await createBrowserProjectWorkspace({
    providers: ['java'],
    files: [{
      path: 'Main.java',
      contents: [
        'public class Main {',
        '  public static void main(String[] args) {',
        '    System.out.println("kernel-java");',
        '  }',
        '}',
      ].join('\n'),
    }],
    traceJVM: {
      createClient() {
        clientCount += 1;
        return {
          async compile() {
            return {
              ...completed(),
              program: {
                files: [{
                  path: 'Main.class',
                  content: new Uint8Array([10, 11, 12]),
                }],
              },
            };
          },
          async run(runRequest) {
            assertCondition(
              runRequest.program.files[0]?.content.join(',') === '10,11,12',
              `java did not read javac output back from TKFS: ${JSON.stringify(runRequest.program)}`
            );
            return completed({ stdout: 'kernel-java\n' });
          },
          terminate() {},
        };
      },
    },
  });
  try {
    const result = await workspace.runCommand(
      'javac -d build Main.java && java -cp build Main'
    );
    assertCondition(
      result.exitCode === 0 &&
        result.stdout === 'kernel-java\n' &&
        clientCount === 2,
      `browser TraceJVM command chain failed: ${JSON.stringify({
        result,
        clientCount,
      })}`
    );
    assertCondition(
      await workspace.readFile('build/Main.class', 'base64') === 'CgsM',
      'javac output was not committed to the authoritative kernel filesystem'
    );
  } finally {
    await workspace.destroy();
  }
}

await testKernelLeaseUsesFreshWorkers();
console.log('PASS: TraceJVM adapter binds one kernel coordinator and fresh Workers per invocation');
await testCancellationHardRetiresWorker();
console.log('PASS: TraceJVM adapter maps signals to hard Worker retirement');
await testUnsupportedBoundaryIsExplicit();
console.log('PASS: TraceJVM adapter exposes its current filesystem boundary');
await testBrowserWorkspaceCommitsArtifactsToTKFS();
console.log('PASS: browser TraceJVM javac/java chains exchange artifacts through TKFS');
