import {
  TraceJVMWorkerClient,
  type TraceJVMWorkerLike,
} from '@tracecode/tracejvm';
import {
  createRuntimeCommandStdinPipeFromText,
} from '../../packages/harness-core/src/index';
import { createBrowserProjectWorkspace } from '../../packages/harness-browser/src/project';

declare global {
  var runTraceKernelTraceJVMTest: (() => Promise<{
    compile: { stdout: string; stderr: string; exitCode: number };
    firstRun: { stdout: string; stderr: string; exitCode: number };
    secondRun: { stdout: string; stderr: string; exitCode: number };
    filesystemRun: { stdout: string; stderr: string; exitCode: number };
    stdinRun: { stdout: string; stderr: string; exitCode: number };
    socketRun: { stdout: string; stderr: string; exitCode: number };
    selectorRun: { stdout: string; stderr: string; exitCode: number };
    processRun: { stdout: string; stderr: string; exitCode: number };
    sharedFile: string;
    randomFile: string;
    childFile: string;
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
    env: { TRACE_PARENT: 'kernel-😀' },
    files: [{
      path: 'Main.java',
      contents: [
        'public final class Main {',
        '  private static int count = 0;',
        '  public static void main(String[] args) throws Exception {',
        '    if (args.length > 0 && args[0].equals("stdin")) {',
        '      byte[] input = System.in.readNBytes(5);',
        '      System.out.println("stdin:" + new String(input, java.nio.charset.StandardCharsets.UTF_8));',
        '      return;',
        '    }',
        '    if (args.length > 0 && args[0].equals("process")) {',
        '      Process sleeper = new ProcessBuilder("java", "-cp", "build", "Sleeper").start();',
        '      String sleeperReady = new java.io.BufferedReader(new java.io.InputStreamReader(sleeper.getInputStream())).readLine();',
        '      java.util.concurrent.CompletableFuture<Process> sleeperExit = sleeper.onExit();',
        '      boolean destroyAccepted = sleeper.toHandle().destroy();',
        '      Process completedSleeper = sleeperExit.get();',
        '      boolean signalMatches = sleeperReady.equals("sleeper-ready")',
        '          && destroyAccepted',
        '          && completedSleeper == sleeper',
        '          && sleeper.exitValue() == 143',
        '          && !sleeper.isAlive();',
        '      ProcessBuilder childBuilder = new ProcessBuilder("java", "-cp", "build", "Child", "trace-😀").redirectErrorStream(true);',
        '      childBuilder.environment().put("TRACE_CHILD", "child-😀");',
        '      Process child = childBuilder.start();',
        '      ProcessHandle childHandle = child.toHandle();',
        '      boolean aliveBefore = child.isAlive();',
        '      boolean listedAsChild = ProcessHandle.current().children().anyMatch(handle -> handle.pid() == child.pid());',
        '      boolean parentMatches = childHandle.parent().map(handle -> handle.pid() == ProcessHandle.current().pid()).orElse(false);',
        '      ProcessHandle.Info childInfo = childHandle.info();',
        '      boolean infoMatches = childInfo.command().orElse("").equals("java")',
        '          && java.util.Arrays.equals(childInfo.arguments().orElse(new String[0]), new String[] {"-cp", "build", "Child", "trace-😀"})',
        '          && childInfo.startInstant().isPresent();',
        '      String childOutput = new String(child.getInputStream().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8).trim();',
        '      boolean childFailure = childOutput.contains("child-failure");',
        '      boolean environmentMatches = childOutput.contains("env:kernel-😀:child-😀");',
        '      int childExit = child.waitFor();',
        '      boolean aliveAfter = child.isAlive();',
        '      String childFile = java.nio.file.Files.exists(java.nio.file.Path.of("process-child.txt"))',
        '          ? java.nio.file.Files.readString(java.nio.file.Path.of("process-child.txt"))',
        '          : "missing";',
        '      System.out.println("process:" + child.pid() + ":" + signalMatches + ":" + aliveBefore + ":" + listedAsChild + ":" + parentMatches + ":" + infoMatches + ":" + environmentMatches + ":" + childExit + ":" + childFailure + ":" + aliveAfter + ":" + childFile);',
        '      return;',
        '    }',
        '    if (args.length > 0 && args[0].equals("filesystem")) {',
        '      java.nio.file.Path path = java.nio.file.Path.of("shared.txt");',
        '      String prior = java.nio.file.Files.readString(path);',
        '      java.nio.file.Files.writeString(path, prior + "|java");',
        '      java.nio.file.Path nested = java.nio.file.Path.of("kernel-dir", "nested");',
        '      java.nio.file.Files.createDirectories(nested);',
        '      java.nio.file.Files.writeString(nested.resolve("child.txt"), "child");',
        '      String random;',
        '      long randomPointer;',
        '      try (var file = new java.io.RandomAccessFile("random.bin", "rw")) {',
        '        file.write("abcdef".getBytes(java.nio.charset.StandardCharsets.UTF_8));',
        '        file.seek(2);',
        '        file.write((int) \'Z\');',
        '        randomPointer = file.getFilePointer();',
        '        file.setLength(4);',
        '        file.seek(0);',
        '        byte[] contents = new byte[(int) file.length()];',
        '        file.readFully(contents);',
        '        random = new String(contents, java.nio.charset.StandardCharsets.UTF_8);',
        '      }',
        '      java.nio.file.Path hardLink = java.nio.file.Path.of("random-hard.bin");',
        '      java.nio.file.Path renamedLink = java.nio.file.Path.of("random-renamed.bin");',
        '      java.nio.file.Path symbolicLink = java.nio.file.Path.of("random-link.bin");',
        '      java.nio.file.Files.createLink(hardLink, java.nio.file.Path.of("random.bin"));',
        '      java.nio.file.Files.createSymbolicLink(symbolicLink, java.nio.file.Path.of("random.bin"));',
        '      String linkTarget = java.nio.file.Files.readSymbolicLink(symbolicLink).toString();',
        '      java.nio.file.Files.move(hardLink, renamedLink);',
        '      boolean sameFile = java.nio.file.Files.isSameFile(java.nio.file.Path.of("random.bin"), renamedLink);',
        '      java.nio.file.Files.delete(symbolicLink);',
        '      boolean linkDeleted = java.nio.file.Files.notExists(symbolicLink, java.nio.file.LinkOption.NOFOLLOW_LINKS);',
        '      String listed;',
        '      try (var entries = java.nio.file.Files.list(java.nio.file.Path.of("kernel-dir"))) {',
        '        listed = entries.map(entry -> entry.getFileName().toString()).sorted().findFirst().orElse("missing");',
        '      }',
        '      boolean millisecondTime = path.toFile().lastModified() > 1_000_000_000_000L;',
        '      System.out.println("fs:" + prior + ":" + listed + ":" + millisecondTime + ":" + random + ":" + randomPointer + ":" + linkTarget + ":" + sameFile + ":" + linkDeleted);',
        '      return;',
        '    }',
        '    if (args.length > 0 && args[0].equals("selector")) {',
        '      java.net.InetAddress loopback = java.net.InetAddress.getLoopbackAddress();',
        '      try (var selector = java.nio.channels.Selector.open();',
        '           var server = java.nio.channels.ServerSocketChannel.open()) {',
        '        server.bind(new java.net.InetSocketAddress(loopback, 0));',
        '        server.configureBlocking(false);',
        '        server.register(selector, java.nio.channels.SelectionKey.OP_ACCEPT);',
        '        var address = (java.net.InetSocketAddress) server.getLocalAddress();',
        '        try (var firstClient = java.nio.channels.SocketChannel.open(address);',
        '             var secondClient = java.nio.channels.SocketChannel.open(address)) {',
        '          boolean acceptReady = selector.select(2000) > 0;',
        '          selector.selectedKeys().clear();',
        '          try (var firstAccepted = server.accept();',
        '               var secondAccepted = server.accept()) {',
        '            if (firstAccepted == null || secondAccepted == null) throw new IllegalStateException("accept queue incomplete");',
        '            firstAccepted.configureBlocking(false);',
        '            secondAccepted.configureBlocking(false);',
        '            firstAccepted.register(selector, java.nio.channels.SelectionKey.OP_READ);',
        '            secondAccepted.register(selector, java.nio.channels.SelectionKey.OP_READ);',
        '            firstClient.write(java.nio.ByteBuffer.wrap(new byte[] {(byte) \'A\'}));',
        '            secondClient.write(java.nio.ByteBuffer.wrap(new byte[] {(byte) \'B\'}));',
        '            int readyCount = selector.select(2000);',
        '            java.util.Set<Character> received = new java.util.HashSet<>();',
        '            for (var key : selector.selectedKeys()) {',
        '              if (!key.isReadable()) continue;',
        '              var channel = (java.nio.channels.SocketChannel) key.channel();',
        '              var byteBuffer = java.nio.ByteBuffer.allocate(1);',
        '              if (channel.read(byteBuffer) == 1) received.add((char) byteBuffer.array()[0]);',
        '            }',
        '            selector.selectedKeys().clear();',
        '            Thread wakeup = new Thread(() -> {',
        '              try { Thread.sleep(50); } catch (InterruptedException error) { throw new RuntimeException(error); }',
        '              selector.wakeup();',
        '            }, "selector-wakeup");',
        '            long started = System.nanoTime();',
        '            wakeup.start();',
        '            int wakeupReady = selector.select(2000);',
        '            long elapsedMillis = java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);',
        '            wakeup.join();',
        '            boolean descriptorsReady = acceptReady && readyCount == 2 && received.equals(java.util.Set.of(\'A\', \'B\'));',
        '            boolean wakeupWorked = wakeupReady == 0 && elapsedMillis < 1500;',
        '            System.out.println("selector:" + descriptorsReady + ":" + wakeupWorked);',
        '          }',
        '        }',
        '      }',
        '      return;',
        '    }',
        '    if (args.length > 0 && args[0].equals("socket")) {',
        '      java.net.InetAddress loopback = java.net.InetAddress.getLoopbackAddress();',
        '      try (var server = new java.net.ServerSocket(0, 8, loopback)) {',
        '        java.util.concurrent.atomic.AtomicReference<Throwable> failure = new java.util.concurrent.atomic.AtomicReference<>();',
        '        Thread serverThread = new Thread(() -> {',
        '          try (var accepted = server.accept()) {',
        '            byte[] request = accepted.getInputStream().readNBytes(4);',
        '            if (!new String(request, java.nio.charset.StandardCharsets.UTF_8).equals("ping")) {',
        '              throw new IllegalStateException("unexpected request");',
        '            }',
        '            accepted.getOutputStream().write("pong".getBytes(java.nio.charset.StandardCharsets.UTF_8));',
        '          } catch (Throwable error) {',
        '            failure.set(error);',
        '          }',
        '        }, "kernel-socket-server");',
        '        serverThread.start();',
        '        try (var client = new java.net.Socket(loopback, server.getLocalPort())) {',
        '          client.getOutputStream().write("ping".getBytes(java.nio.charset.StandardCharsets.UTF_8));',
        '          byte[] response = client.getInputStream().readNBytes(4);',
        '          serverThread.join();',
        '          if (failure.get() != null) throw new RuntimeException(failure.get());',
        '          System.out.println("socket:" + new String(response, java.nio.charset.StandardCharsets.UTF_8));',
        '        }',
        '      }',
        '      return;',
        '    }',
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
    }, {
      path: 'shared.txt',
      contents: 'snapshot-value',
    }, {
      path: 'Child.java',
      contents: [
        'public final class Child {',
        '  public static void main(String[] args) throws Exception {',
        '    java.nio.file.Files.writeString(java.nio.file.Path.of("process-child.txt"), "java-child");',
        '    System.out.println("env:" + System.getenv("TRACE_PARENT") + ":" + System.getenv("TRACE_CHILD"));',
        '    Thread.sleep(250);',
        '    throw new RuntimeException("child-failure");',
        '  }',
        '}',
      ].join('\n'),
    }, {
      path: 'Sleeper.java',
      contents: [
        'public final class Sleeper {',
        '  public static void main(String[] args) throws Exception {',
        '    System.out.println("sleeper-ready");',
        '    while (true) Thread.sleep(1000);',
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
            workingDirectory: context.cwd,
            hostStandardDescriptors: context.hostStandardDescriptors,
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
    const compile = await workspace.runCommand(
      'javac -d build Main.java Child.java Sleeper.java'
    );
    if (compile.exitCode !== 0) {
      throw new Error(`TraceJVM compile failed: ${JSON.stringify(compile)}`);
    }
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
    await workspace.writeFile('shared.txt', 'js-before-java');
    const filesystemRun = await workspace.runCommand(
      'java -cp build Main filesystem'
    );
    const sharedFile = await workspace.readFile('shared.txt');
    const randomFile = await workspace.readFile('random.bin');
    await workspace.deleteFile('random-link.bin');
    const stdinRun = await workspace.runCommand(
      'java -cp build Main stdin',
      {
        stdinPipe: createRuntimeCommandStdinPipeFromText('hello'),
      }
    );
    const socketRun = await workspace.runCommand(
      'java -cp build Main socket'
    );
    const selectorRun = await workspace.runCommand(
      'java -cp build Main selector'
    );
    const processRun = await workspace.runCommand(
      'java -cp build Main process'
    );
    const childFile = await workspace.readFile('process-child.txt')
      .catch(() => 'missing');

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
      interruptedOperation.then((result) => {
        throw new Error(
          `TraceJVM loop exited before readiness: ${JSON.stringify(result)}`
        );
      }),
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
      filesystemRun,
      stdinRun,
      socketRun,
      selectorRun,
      processRun,
      sharedFile,
      randomFile,
      childFile,
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
