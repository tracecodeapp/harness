import {
  TraceJVMWorkerClient,
  type TraceJVMWorkerLike,
} from '@tracecode/tracejvm';
import { createBrowserProjectWorkspace } from '../../packages/harness-browser/src/project';

declare global {
  var runTraceKernelTraceJVMTest: (() => Promise<{
    compile: { stdout: string; stderr: string; exitCode: number };
    firstRun: { stdout: string; stderr: string; exitCode: number };
    secondRun: { stdout: string; stderr: string; exitCode: number };
    interrupted: {
      stdout: string;
      stderr: string;
      exitCode: number;
      handledSignal?: string;
    };
    restarted: { stdout: string; stderr: string; exitCode: number };
    classFileBase64: string;
    workerCount: number;
    reports: Array<{
      source: string;
      status: string;
      isolation: string;
      retirementRecommended: boolean;
    }>;
  }>) | undefined;
}

globalThis.runTraceKernelTraceJVMTest = async () => {
  let workerCount = 0;
  const reports: Array<{
    source: string;
    status: string;
    isolation: string;
    retirementRecommended: boolean;
  }> = [];
  const workspace = await createBrowserProjectWorkspace({
    providers: ['java'],
    files: [{
      path: 'Main.java',
      contents: [
        'public final class Main {',
        '  private static int count = 0;',
        '  public static void main(String[] args) {',
        '    count += 1;',
        '    String mode = System.getProperty("mode", "missing");',
        '    String leaked = System.getProperty("tracejvm.leak", "missing");',
        '    if (args.length > 0 && args[0].equals("loop")) {',
        '      System.out.println("loop-ready");',
        '      while (true) count += 1;',
        '    }',
        '    System.out.println(count + ":" + mode + ":" + leaked + ":" + args[0]);',
        '    System.setProperty("tracejvm.leak", "mutated");',
        '  }',
        '}',
      ].join('\n'),
    }],
    traceJVM: {
      createClient(context) {
        workerCount += 1;
        return new TraceJVMWorkerClient({
          engine: {
            assets: {
              runtimeProfileBaseUrls: {
                core: '/tracejvm/profiles/core',
              },
              wasmUrl: '/tracejvm/bjvm_main.wasm',
            },
            runtimeProfile: 'core',
            retirementAfterExecutions: 1,
          },
          createWorker: () => new Worker('/tracejvm/browser-worker.js', {
            type: 'module',
          }) as unknown as TraceJVMWorkerLike,
          ...(context.host ? { host: context.host } : {}),
        });
      },
      onExecutionReport(report) {
        reports.push({
          source: report.source,
          status: report.result.status,
          isolation: report.result.isolation.status,
          retirementRecommended: report.result.retirementRecommended,
        });
      },
    },
  });

  try {
    const compile = await workspace.runCommand('javac -d build Main.java');
    const classFileBase64 = await workspace.readFile(
      'build/Main.class',
      'base64'
    );
    const firstRun = await workspace.runCommand(
      'java -cp build -Dmode=first Main first'
    );
    const secondRun = await workspace.runCommand(
      'java -cp build Main second'
    );

    const controller = new AbortController();
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const stopWatching = workspace.watch((event) => {
      if (
        event.type === 'output' &&
        event.stream === 'stdout' &&
        event.data.includes('loop-ready')
      ) {
        resolveReady();
      }
    });
    const interruptedOperation = workspace.runCommand(
      'java -cp build Main loop',
      { signal: controller.signal }
    );
    await Promise.race([
      ready,
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error('TraceJVM loop did not become ready in time.')),
          20_000
        );
      }),
    ]);
    controller.abort({ signal: 'SIGINT', source: 'browser-test' });
    const interrupted = await interruptedOperation;
    stopWatching();

    const restarted = await workspace.runCommand(
      'java -cp build Main restarted'
    );
    return {
      compile,
      firstRun,
      secondRun,
      interrupted,
      restarted,
      classFileBase64,
      workerCount,
      reports,
    };
  } finally {
    await workspace.destroy();
  }
};
