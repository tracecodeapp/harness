#!/usr/bin/env npx tsx

import type {
  RuntimeCommandEvent,
  RuntimeProjectCommandRequest,
  RuntimeProjectEngineLeaseAttachment,
  RuntimeProjectEngineLeaseController,
} from '../packages/runtime-contracts/src/index';
import {
  createJavaProjectRunner,
  type JavaProjectClient,
} from '../packages/runtime-java/src/java-project';
import {
  createJavaProjectClientFactory,
} from '../packages/runtime-java/src/java-project-client';
import { createBrowserProjectWorkspace } from '../packages/runtime-browser/src/project';

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
  overrides: Partial<Awaited<ReturnType<JavaProjectClient['run']>>> = {}
): Awaited<ReturnType<JavaProjectClient['run']>> {
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

function testProjectFactoryRejectsUnknownRuntimeProfiles(): void {
  let profileError: unknown;
  try {
    createJavaProjectClientFactory({
      runtimeProfile: 'desktop' as never,
    });
  } catch (error) {
    profileError = error;
  }
  assertCondition(
    profileError instanceof TypeError &&
      profileError.message.includes(
        'Unsupported TraceJVM runtime profile: desktop'
      ),
    `Unknown TraceJVM runtime profiles must fail before allocating workers: ${String(profileError)}`
  );
}

async function testProjectFactorySeparatesWorkerAndPayloadOrigins(): Promise<void> {
  const workerUrls: string[] = [];
  const expectedFailure = new Error('stop after resolving worker URL');
  const factory = createJavaProjectClientFactory({
    runtimeAssetBaseUrl: 'https://runtime-assets.example/java/tracejvm/release',
    createWorker(workerUrl) {
      workerUrls.push(workerUrl);
      throw expectedFailure;
    },
  });
  try {
    const client = await factory({
      cwd: '/workspace',
      hostStandardDescriptors: false,
    });
    const initialize = client.initialize;
    if (initialize === undefined) {
      throw new Error(
        'TraceJVM project clients must expose compiler initialization'
      );
    }
    let failure: unknown;
    try {
      await initialize.call(client);
    } catch (error) {
      failure = error;
    }
    assertCondition(
      failure === expectedFailure &&
        workerUrls.length === 1 &&
        workerUrls[0] ===
          'https://runtime-assets.example/java/tracejvm/release/browser-worker.js',
      `TraceJVM runtime overrides must keep the Worker in the configured tree: ${JSON.stringify(workerUrls)}`
    );
  } finally {
    factory.terminate();
  }

  const explicitWorkerUrls: string[] = [];
  const explicitFactory = createJavaProjectClientFactory({
    runtimeAssetBaseUrl: 'https://runtime-assets.example/java/tracejvm/release',
    workerUrl: '/workers/java/tracejvm/browser-worker.js?v=3#compiler',
    createWorker(workerUrl) {
      explicitWorkerUrls.push(workerUrl);
      throw expectedFailure;
    },
  });
  try {
    const client = await explicitFactory({
      cwd: '/workspace',
      hostStandardDescriptors: false,
    });
    const initialize = client.initialize;
    if (initialize === undefined) {
      throw new Error(
        'TraceJVM project clients must expose compiler initialization'
      );
    }
    await initialize.call(client).catch(() => undefined);
    assertCondition(
      explicitWorkerUrls.length === 1 &&
        explicitWorkerUrls[0] ===
          '/workers/java/tracejvm/browser-worker.js?v=3#compiler',
      `TraceJVM hosts must be able to separate a same-origin Worker from CDN payloads: ${JSON.stringify(explicitWorkerUrls)}`
    );
  } finally {
    explicitFactory.terminate();
  }
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
  const runner = createJavaProjectRunner({
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
              runRequest.systemProperties?.mode === 'test' &&
              runRequest.systemProperties?.['user.dir'] === '/workspace/service',
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
    `Java project run result changed: ${JSON.stringify(run)}`
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
    'Java project provider must not claim mutable Worker revalidation before reset proof exists'
  );
  await attachment?.release({ kind: 'destroy', reason: 'unvalidated' });
}

async function testCancellationHardRetiresWorker(): Promise<void> {
  let terminateCount = 0;
  let rejectRun: ((error: Error) => void) | undefined;
  const runner = createJavaProjectRunner({
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
    `SIGINT did not hard-retire the Java project client: ${JSON.stringify({
      result,
      terminateCount,
    })}`
  );
}

async function testUnsupportedBoundaryIsExplicit(): Promise<void> {
  let clientCount = 0;
  const runner = createJavaProjectRunner({
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
    `unsupported Java project filesystem semantics were not explicit: ${JSON.stringify(result)}`
  );
}

async function testClientReuseIsRejected(): Promise<void> {
  let terminateCount = 0;
  const reusedClient: JavaProjectClient = {
    async compile() {
      throw new Error('compile should not run');
    },
    async run() {
      return completed();
    },
    terminate() {
      terminateCount += 1;
    },
  };
  const runner = createJavaProjectRunner({
    createClient: () => reusedClient,
  });
  const first = await runner(request('run', []));
  const second = await runner(request('run', []));
  assertCondition(
    first.exitCode === 0 &&
      second.exitCode !== 0 &&
      String(second.error?.detail?.diagnostic).includes('mutable VM reuse') &&
      terminateCount >= 2,
    `reused Java project client was admitted across processes: ${JSON.stringify({
      first,
      second,
      terminateCount,
    })}`
  );
}

async function testProcessHostMapsGenericPosixCalls(): Promise<void> {
  const dispatched: unknown[] = [];
  const runRequest = request('run', []);
  runRequest.kernelSyscalls = {
    channel: {
      buffer: new SharedArrayBuffer(264),
      byteCapacity: 256,
    },
    async dispatch(syscall) {
      dispatched.push(syscall);
      if (
        typeof syscall === 'object' &&
        syscall !== null &&
        (syscall as { op?: unknown }).op === 'open'
      ) {
        return { ok: true, value: { op: 'open', fd: 17 } };
      }
      return {
        ok: false,
        error: { code: 'EBADF', message: 'bad file descriptor' },
      };
    },
    async service() {},
    close() {},
  };
  const runner = createJavaProjectRunner({
    createClient(context) {
      assertCondition(
        context.cwd === '/workspace/service' &&
          context.hostStandardDescriptors === true &&
          context.process?.pid === 42 &&
          context.host !== undefined,
        `Java project client did not receive its process-scoped host: ${JSON.stringify(context.process)}`
      );
      return {
        async compile() {
          throw new Error('compile should not run');
        },
        async run() {
          const opened = await context.host!.dispatch({
            service: 'posix',
            operation: 'open',
            payload: {
              path: '/workspace/service/data.txt',
              options: { read: true },
            },
          });
          assertCondition(
            JSON.stringify(opened) === JSON.stringify({ fd: 17 }),
            `TraceKernel syscall value was not normalized: ${JSON.stringify(opened)}`
          );
          let failure: unknown;
          try {
            await context.host!.dispatch({
              service: 'posix',
              operation: 'close',
              payload: { fd: 999 },
            });
          } catch (error) {
            failure = error;
          }
          assertCondition(
            failure instanceof Error &&
              failure.name === 'EBADF' &&
              failure.message === 'bad file descriptor',
            `TraceKernel errno was not preserved for Java: ${String(failure)}`
          );
          return completed();
        },
        terminate() {},
      };
    },
  });

  const result = await runner(runRequest);
  assertCondition(
    result.exitCode === 0 &&
      JSON.stringify(dispatched) === JSON.stringify([
        {
          path: '/workspace/service/data.txt',
          options: { read: true },
          op: 'open',
        },
        { fd: 999, op: 'close' },
      ]),
    `Java project host calls did not reach the process syscall bridge: ${JSON.stringify({
      result,
      dispatched,
    })}`
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
    java: {
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
      `browser Java project command chain failed: ${JSON.stringify({
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

async function testBrowserWorkspaceRequiresExplicitJavaProvider(): Promise<void> {
  const defaultWorkspace = await createBrowserProjectWorkspace({
    files: [{ path: 'Main.java', contents: 'class Main {}\n' }],
  });
  try {
    const implicitJava = await defaultWorkspace.runCommand('javac Main.java');
    assertCondition(
      implicitJava.exitCode !== 0 &&
        /command (?:not found|not available)/u.test(implicitJava.stderr),
      `Java must not be selected without an explicit provider: ${JSON.stringify(implicitJava)}`
    );
  } finally {
    await defaultWorkspace.destroy();
  }

  let missingProviderError: unknown;
  try {
    await createBrowserProjectWorkspace({
      providers: ['java'],
      files: [{ path: 'Main.java', contents: 'class Main {}\n' }],
    });
  } catch (error) {
    missingProviderError = error;
  }
  assertCondition(
    missingProviderError instanceof Error &&
      missingProviderError.message.includes('requires a Java 23 project provider') &&
      missingProviderError.message.includes('java.createClient'),
    `Java did not require an explicit project provider: ${String(missingProviderError)}`
  );

  let injectedProviderInvocations = 0;
  const injectedProviderWorkspace = await createBrowserProjectWorkspace({
    files: [{ path: 'Main.java', contents: 'class Main {}\n' }],
    runtimeProviders: {
      java: {
        async execute() {
          injectedProviderInvocations += 1;
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      },
    },
  });
  try {
    const result = await injectedProviderWorkspace.runCommand('javac Main.java');
    assertCondition(
      result.exitCode === 0 && injectedProviderInvocations === 1,
      `explicit Java runtime provider was not invoked: ${JSON.stringify({
        result,
        injectedProviderInvocations,
      })}`
    );
  } finally {
    await injectedProviderWorkspace.destroy();
  }

  let injectedLifecycleCalls = 0;
  const callerOwnedProvider = {
    async execute() {
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    warm() {
      injectedLifecycleCalls += 1;
    },
    reset() {
      injectedLifecycleCalls += 1;
    },
    terminate() {
      injectedLifecycleCalls += 1;
    },
    dispose() {
      injectedLifecycleCalls += 1;
    },
  };
  const callerOwnedWorkspace = await createBrowserProjectWorkspace({
    files: [{ path: 'Main.java', contents: 'class Main {}\n' }],
    runtimeProviders: { java: callerOwnedProvider },
  });
  const callerOwnedResult = await callerOwnedWorkspace.runCommand(
    'javac Main.java'
  );
  assertCondition(
    callerOwnedResult.exitCode === 0,
    `caller-owned Java runtime provider should execute commands: ${JSON.stringify(callerOwnedResult)}`
  );
  const resetResult = await callerOwnedWorkspace.runCommand(
    'tracekernelctl reset'
  );
  assertCondition(
    resetResult.exitCode === 0,
    `caller-owned Java runtime provider should survive workspace reset: ${JSON.stringify(resetResult)}`
  );
  await callerOwnedWorkspace.destroy();
  assertCondition(
    injectedLifecycleCalls === 0,
    'Browser Project must never warm, reset, terminate, or dispose caller-owned runtime providers'
  );

  let excludedProviderError: unknown;
  try {
    await createBrowserProjectWorkspace({
      providers: [],
      files: [{ path: 'Main.java', contents: 'class Main {}\n' }],
      runtimeProviders: {
        java: {
          async execute() {
            return { stdout: '', stderr: '', exitCode: 0 };
          },
        },
      },
    });
  } catch (error) {
    excludedProviderError = error;
  }
  assertCondition(
    excludedProviderError instanceof Error &&
      excludedProviderError.message.includes(
        'runtimeProviders.java requires providers to include "java"'
      ),
    `An explicit provider list must remain authoritative: ${String(excludedProviderError)}`
  );

  let unknownProviderError: unknown;
  try {
    await createBrowserProjectWorkspace({
      runtimeProviders: {
        ruby: {
          async execute() {
            return { stdout: '', stderr: '', exitCode: 0 };
          },
        },
      } as never,
    });
  } catch (error) {
    unknownProviderError = error;
  }
  assertCondition(
    unknownProviderError instanceof TypeError &&
      unknownProviderError.message.includes(
        'Browser project runtime provider "ruby" is not supported'
      ),
    `Unknown injected Project runtimes must fail before workspace boot: ${String(unknownProviderError)}`
  );
}

async function testBrowserWorkspaceKeepsTraceJVMWorkerSameOrigin(): Promise<void> {
  const previousWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const workerUrls: string[] = [];
  const expectedFailure = new Error('stop after resolving browser project worker');
  class RecordingWorker {
    constructor(url: string | URL) {
      workerUrls.push(String(url));
      throw expectedFailure;
    }
  }
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    writable: true,
    value: RecordingWorker,
  });
  try {
    const workspace = await createBrowserProjectWorkspace({
      providers: ['java'],
      assetBaseUrl: 'https://runtime-assets.example/harness/release',
      files: [{ path: 'Main.java', contents: 'class Main {}\n' }],
    });
    try {
      const result = await workspace.runCommand('javac Main.java');
      assertCondition(
        result.exitCode !== 0 &&
          workerUrls.length === 1 &&
          workerUrls[0]!.startsWith('/workers/java/tracejvm/') &&
          workerUrls[0]!.endsWith('/browser-worker.js'),
        `a CDN payload base must retain the built-in same-origin TraceJVM Worker: ${JSON.stringify({ result, workerUrls })}`
      );
    } finally {
      await workspace.destroy();
    }

    workerUrls.length = 0;
    const customWorkspace = await createBrowserProjectWorkspace({
      providers: ['java'],
      assetBaseUrl: 'https://runtime-assets.example/harness/release',
      javaProjectWorkerUrl:
        '/custom-workers/tracejvm/browser-worker.js?v=3#project',
      files: [{ path: 'Main.java', contents: 'class Main {}\n' }],
    });
    try {
      await customWorkspace.runCommand('javac Main.java');
      assertCondition(
        workerUrls.length === 1 &&
          workerUrls[0] ===
            '/custom-workers/tracejvm/browser-worker.js?v=3#project',
        `custom hosts must be able to override the same-origin TraceJVM Worker: ${JSON.stringify(workerUrls)}`
      );
    } finally {
      await customWorkspace.destroy();
    }
  } finally {
    if (previousWorker) {
      Object.defineProperty(globalThis, 'Worker', previousWorker);
    } else {
      Reflect.deleteProperty(globalThis, 'Worker');
    }
  }
}

await testKernelLeaseUsesFreshWorkers();
console.log('PASS: Java project adapter binds one kernel coordinator and fresh process clients per invocation');
testProjectFactoryRejectsUnknownRuntimeProfiles();
console.log('PASS: Java project factory rejects unknown runtime profiles');
await testProjectFactorySeparatesWorkerAndPayloadOrigins();
console.log('PASS: Java project factory separates same-origin Workers from immutable payloads');
await testCancellationHardRetiresWorker();
console.log('PASS: Java project adapter maps signals to hard Worker retirement');
await testUnsupportedBoundaryIsExplicit();
console.log('PASS: Java project adapter exposes its current filesystem boundary');
await testClientReuseIsRejected();
console.log('PASS: Java project adapter rejects mutable client reuse');
await testProcessHostMapsGenericPosixCalls();
console.log('PASS: Java project POSIX host maps to process-scoped TraceKernel syscalls');
await testBrowserWorkspaceCommitsArtifactsToTKFS();
console.log('PASS: browser Java javac/java chains exchange artifacts through TKFS');
await testBrowserWorkspaceRequiresExplicitJavaProvider();
console.log('PASS: browser Java derives omitted provider selection but honors explicit provider lists');
await testBrowserWorkspaceKeepsTraceJVMWorkerSameOrigin();
console.log('PASS: browser Java keeps TraceJVM Workers same-origin while payloads use a CDN');
