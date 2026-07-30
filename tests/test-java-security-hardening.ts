#!/usr/bin/env npx tsx

import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function loadSourceAugmentations(): {
  augmentJavaCollectionOperations: (source: string, sourceText?: string) => string;
} {
  const source = readFileSync(join(process.cwd(), 'workers', 'java', 'java-source-augmentations.js'), 'utf8');
  const moduleObject = { exports: {} };
  const context = vm.createContext({
    module: moduleObject,
    exports: moduleObject.exports,
    self: {},
  });
  vm.runInContext(source, context, { filename: 'java-source-augmentations.js' });
  return moduleObject.exports as {
    augmentJavaCollectionOperations: (source: string, sourceText?: string) => string;
  };
}

function assertJavaDeleteOnCloseLiveDeleteContract(): void {
  const projectEventsPath = join(
    process.cwd(),
    'workers',
    'java',
    'src',
    'tracecode',
    'browser',
    'ProjectEvents.java'
  );
  const projectEventsSource = readFileSync(projectEventsPath, 'utf8');

  assertCondition(
    projectEventsSource.includes('optionDeletesOnClose') &&
      projectEventsSource.includes('StandardOpenOption.DELETE_ON_CLOSE') &&
      projectEventsSource.includes('emitPostWritePathChange(path, optionDeletesOnClose(options))') &&
      projectEventsSource.includes('emitFileDelete(path)'),
    'ProjectEvents should route DELETE_ON_CLOSE writes through live delete emission'
  );
  assertCondition(
    /byteChannelCanWrite[\s\S]*StandardOpenOption\.DELETE_ON_CLOSE/.test(projectEventsSource),
    'ProjectEvents should treat DELETE_ON_CLOSE byte-channel opens as mutating operations'
  );
  assertCondition(
    /ProjectOutputStream[\s\S]*deleteOnClose[\s\S]*emitPostWritePathChange\(path, deleteOnClose\)/.test(projectEventsSource) &&
      /ProjectBufferedWriter[\s\S]*deleteOnClose[\s\S]*emitPostWritePathChange\(path, deleteOnClose\)/.test(projectEventsSource) &&
      /ProjectSeekableByteChannel[\s\S]*deleteOnClose[\s\S]*emitPostWritePathChange\(path, deleteOnClose\)/.test(projectEventsSource),
    'ProjectEvents stream, writer, and byte-channel wrappers should emit delete-on-close state on close'
  );

  const tmpRoot = mkdtempSync(join(tmpdir(), 'tracecode-java-delete-on-close-'));
  try {
    const classesPath = join(tmpRoot, 'classes');
    const smokePath = join(tmpRoot, 'ProjectEventsDeleteOnCloseSmoke.java');
    mkdirSync(classesPath);
    writeFileSync(
      smokePath,
      `import java.io.BufferedWriter;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.channels.SeekableByteChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import tracecode.browser.ProjectEvents;

public class ProjectEventsDeleteOnCloseSmoke {
  public static void main(String[] args) throws Exception {
    Path root = Files.createTempDirectory("tracecode-java-doc-smoke-");
    try {
      Path streamPath = root.resolve("stream.txt");
      try (OutputStream stream = ProjectEvents.newOutputStream(
          streamPath,
          StandardOpenOption.CREATE,
          StandardOpenOption.WRITE,
          StandardOpenOption.DELETE_ON_CLOSE
      )) {
        stream.write("stream".getBytes(StandardCharsets.UTF_8));
      }
      requireDeleted(streamPath, "stream");

      Path writerPath = root.resolve("writer.txt");
      try (BufferedWriter writer = ProjectEvents.newBufferedWriter(
          writerPath,
          StandardCharsets.UTF_8,
          StandardOpenOption.CREATE,
          StandardOpenOption.WRITE,
          StandardOpenOption.DELETE_ON_CLOSE
      )) {
        writer.write("writer");
      }
      requireDeleted(writerPath, "writer");

      Path channelPath = root.resolve("channel.txt");
      try (SeekableByteChannel channel = ProjectEvents.newByteChannel(
          channelPath,
          StandardOpenOption.CREATE,
          StandardOpenOption.WRITE,
          StandardOpenOption.DELETE_ON_CLOSE
      )) {
        channel.write(ByteBuffer.wrap("channel".getBytes(StandardCharsets.UTF_8)));
      }
      requireDeleted(channelPath, "channel");

      Path writeStringPath = root.resolve("write-string.txt");
      ProjectEvents.writeString(
        writeStringPath,
        "write-string",
        StandardOpenOption.CREATE,
        StandardOpenOption.WRITE,
        StandardOpenOption.DELETE_ON_CLOSE
      );
      requireDeleted(writeStringPath, "writeString");

      System.out.println("delete-on-close-ok");
    } finally {
      try (var paths = Files.walk(root)) {
        paths.sorted(java.util.Comparator.reverseOrder()).forEach((path) -> {
          try {
            Files.deleteIfExists(path);
          } catch (Exception ignored) {
          }
        });
      }
    }
  }

  private static void requireDeleted(Path path, String label) {
    if (Files.exists(path)) {
      throw new IllegalStateException(label + " path remained observable: " + path);
    }
  }
}
`,
      'utf8'
    );

    execFileSync('javac', ['-d', classesPath, projectEventsPath, smokePath], {
      cwd: process.cwd(),
      stdio: 'pipe',
    });
    const output = execFileSync('java', ['-cp', classesPath, 'ProjectEventsDeleteOnCloseSmoke'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
    assertCondition(output === 'delete-on-close-ok', `ProjectEvents DELETE_ON_CLOSE smoke failed: ${output}`);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }

  console.log('PASS: Java ProjectEvents DELETE_ON_CLOSE closes with delete semantics');
}

function assertJavaProjectFileReaderDeviceCloseReleasesSuperclass(): void {
  const projectEventsPath = join(
    process.cwd(),
    'workers',
    'java',
    'src',
    'tracecode',
    'browser',
    'ProjectEvents.java'
  );
  const projectEventsSource = readFileSync(projectEventsPath, 'utf8');
  assertCondition(
    /ProjectFileReader[\s\S]*deviceReader\.close\(\);[\s\S]*super\.close\(\);[\s\S]*addSuppressed\(error\)/.test(
      projectEventsSource
    ),
    'ProjectFileReader should close both the device reader and inherited FileReader target'
  );

  const tmpRoot = mkdtempSync(join(tmpdir(), 'tracecode-java-reader-close-'));
  try {
    const classesPath = join(tmpRoot, 'classes');
    const smokePath = join(tmpRoot, 'ProjectEventsReaderCloseSmoke.java');
    mkdirSync(classesPath);
    writeFileSync(
      smokePath,
      `import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import tracecode.browser.ProjectEvents;

public class ProjectEventsReaderCloseSmoke {
  public static void main(String[] args) throws Exception {
    Path fdDirectory = fdDirectory();
    if (fdDirectory == null) {
      System.out.println("reader-close-skipped");
      return;
    }

    ProjectEvents.setKernelDevices(device("/dev/stdin", "1", "0", "/dev/stdin", ""));
    try {
      int before = countOpenFileDescriptors(fdDirectory);
      for (int index = 0; index < 64; index += 1) {
        try (ProjectEvents.ProjectFileReader reader = new ProjectEvents.ProjectFileReader("/dev/stdin")) {
        }
      }
      int after = countOpenFileDescriptors(fdDirectory);
      if (after - before > 4) {
        throw new IllegalStateException("ProjectFileReader leaked descriptors: before=" + before + " after=" + after);
      }
      System.out.println("reader-close-ok");
    } finally {
      ProjectEvents.clearKernelDevices();
    }
  }

  private static Path fdDirectory() {
    Path proc = Path.of("/proc/self/fd");
    if (Files.isDirectory(proc)) return proc;
    Path dev = Path.of("/dev/fd");
    if (Files.isDirectory(dev)) return dev;
    return null;
  }

  private static int countOpenFileDescriptors(Path directory) throws IOException {
    int count = 0;
    try (DirectoryStream<Path> stream = Files.newDirectoryStream(directory)) {
      for (Path ignored : stream) {
        count += 1;
      }
    }
    return count;
  }

  private static String device(String path, String readable, String writable, String input, String output) {
    return b64(path) + "\\t" + b64(readable) + "\\t" + b64(writable) + "\\t" + b64(input) + "\\t" + b64(output);
  }

  private static String b64(String value) {
    return Base64.getEncoder().encodeToString(value.getBytes(StandardCharsets.UTF_8));
  }
}
`,
      'utf8'
    );

    execFileSync('javac', ['-d', classesPath, projectEventsPath, smokePath], {
      cwd: process.cwd(),
      stdio: 'pipe',
    });
    const output = execFileSync('java', ['-cp', classesPath, 'ProjectEventsReaderCloseSmoke'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
    assertCondition(
      output === 'reader-close-ok' || output === 'reader-close-skipped',
      `ProjectEvents ProjectFileReader close smoke failed: ${output}`
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }

  console.log('PASS: Java ProjectFileReader closes inherited device target');
}

function assertJavaLexicalScannersAreCached(): void {
  const augmentationSource = readFileSync(join(process.cwd(), 'workers', 'java', 'java-source-augmentations.js'), 'utf8');
  const workerSource = readFileSync(join(process.cwd(), 'workers', 'java', 'java-worker.js'), 'utf8');
  const rewriteLibrarySource = readFileSync(
    join(process.cwd(), 'workers', 'java', 'src', 'harness', 'browser', 'JavaRewriteLibrary.java'),
    'utf8'
  );
  const adapterSource = readFileSync(
    join(process.cwd(), 'packages', 'runtime-contracts', 'src', 'trace-adapters', 'java.ts'),
    'utf8'
  );
  const stripCommentStart = rewriteLibrarySource.indexOf('private static String stripTrailingLineComment');
  const stripCommentEnd = rewriteLibrarySource.indexOf('private static boolean startsMultilineInitializer', stripCommentStart);
  const stripCommentSource = rewriteLibrarySource.slice(stripCommentStart, stripCommentEnd);

  assertCondition(
    augmentationSource.includes('javaLexicalStateCache') &&
      augmentationSource.includes('buildJavaLineLexicalState') &&
      !/function isInsideJavaStringLiteral[\s\S]*?for \(let index = 0; index < offset; index \+= 1\)/.test(augmentationSource) &&
      !/function isInsideJavaComment[\s\S]*?for \(let index = 0; index < offset; index \+= 1\)/.test(augmentationSource),
    'Java source augmentations should use cached lexical state instead of prefix rescans'
  );
  assertCondition(
    workerSource.includes('javaWorkerLexicalStateCache') &&
      workerSource.includes('buildJavaWorkerLineLexicalState') &&
      !/function isInsideJavaStringLiteral[\s\S]*?for \(let index = 0; index < offset; index \+= 1\)/.test(workerSource),
    'Java worker fallback augmentation should use cached lexical state instead of prefix rescans'
  );
  assertCondition(
    stripCommentSource.includes('trimTrailingWhitespace(line, index)') &&
      stripCommentSource.includes('Character.isWhitespace') &&
      !stripCommentSource.includes('replaceAll("\\\\s+$", "")'),
    'Java rewrite line-comment stripping should trim trailing whitespace without regex backtracking'
  );
  assertCondition(
    adapterSource.includes('pieces.push(line.slice(segmentStart, index))') &&
      !adapterSource.includes('result += current'),
    'Java trace adapter comment stripping should avoid per-character string concatenation'
  );

  const augmentations = loadSourceAugmentations();
  const source = `class Solution {
  void solve() {
    java.util.List<Integer> nums = new java.util.ArrayList<>();
    String text = "nums.add(99)";
    nums.add(1);
  }
}`;
  const augmented = augmentations.augmentJavaCollectionOperations(source, source);
  assertCondition(augmented.includes('"nums.add(99)"'), 'Java augmentation should preserve receiver calls inside strings');
  assertCondition(
    augmented.includes('TraceHooks.addCollectionAtLine') &&
      !augmented.includes('nums.add(1);'),
    'Java augmentation should still rewrite executable receiver calls'
  );

  console.log('PASS: Java lexical scanners avoid quadratic prefix rescans');
}

function assertJavaCompileCachePathsArePerExecution(): void {
  const workerSource = readFileSync(join(process.cwd(), 'workers', 'java', 'java-worker.js'), 'utf8');
  const helperSource = readFileSync(
    join(process.cwd(), 'workers', 'java', 'src', 'tracecode', 'browser', 'BrowserCompileAndTraceLibrary.java'),
    'utf8'
  );

  assertCondition(
    /async function runJavaCodeRequest\(payload, requestId\)[\s\S]*isolateJavaCompileId\(buildJavaCompileId\(normalizedPayload, 'execute'\), requestId\)/.test(workerSource),
    'Java execute-code should derive class output paths from a per-execution compile id'
  );
  assertCondition(
    /async function runJavaCodeBatchRequest\(payload, requestId\)[\s\S]*isolateJavaCompileId\(buildJavaBatchCompileId\(normalizedPayload, inputBatch\), requestId\)/.test(workerSource),
    'Java execute-code-batch should derive class output paths from a per-execution compile id'
  );
  assertCondition(
    /async function runJavaProjectRequest\(payload, requestId\)[\s\S]*const compileId = isolateJavaCompileId\(stableHash\(\{[\s\S]*?\}\), requestId\);/.test(workerSource),
    'Java project execution should derive class output paths from a per-execution compile id'
  );

  let randomWord = 0x12345678;
  const context = vm.createContext({
    console,
    self: {
      postMessage: () => {},
      location: { href: 'http://localhost/workers/java/java-worker.js', origin: 'http://localhost', search: '' },
    },
    URL,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Uint32Array,
    SharedArrayBuffer,
    Int32Array,
    Atomics,
    crypto: {
      getRandomValues(values: Uint32Array): Uint32Array {
        for (let index = 0; index < values.length; index += 1) {
          randomWord = (Math.imul(randomWord, 1664525) + 1013904223) >>> 0;
          values[index] = randomWord;
        }
        return values;
      },
    },
    performance: { now: () => 17 },
    queueMicrotask: (callback: () => void) => callback(),
    setTimeout: () => 0,
    clearTimeout: () => {},
    btoa: (binary: string) => Buffer.from(binary, 'binary').toString('base64'),
    atob: (encoded: string) => Buffer.from(encoded, 'base64').toString('binary'),
  });
  vm.runInContext(workerSource, context, { filename: 'java-worker.js' });
  const result = vm.runInContext(
    `(() => {
      const payload = normalizeJavaExecutionPayload({
        code: 'class Solution { int add(int a, int b) { return a + b; } }',
        functionName: 'add',
        executionStyle: 'function',
        inputs: { a: 1, b: 2 }
      });
      const stableExecuteId = buildJavaCompileId(payload, 'execute');
      const firstExecuteId = isolateJavaCompileId(stableExecuteId, 'request-one');
      const secondExecuteId = isolateJavaCompileId(stableExecuteId, 'request-two');
      const firstDynamicPath = dynamicInputEntriesForPayload(payload, stableExecuteId)[0].path;
      const secondDynamicPath = dynamicInputEntriesForPayload(payload, stableExecuteId)[0].path;
      const projectStableId = stableHash({
        compileMode: 'project',
        request: {
          files: [['Main.java', 'class Main { public static void main(String[] args) {} }']],
          source: 'run',
          scriptPath: 'Main',
          args: [],
          classpath: ''
        }
      });
      const firstProjectId = isolateJavaCompileId(projectStableId, 'project-one');
      const secondProjectId = isolateJavaCompileId(projectStableId, 'project-two');
      return {
        stableExecuteId,
        firstExecuteId,
        secondExecuteId,
        firstExecuteClassesDir: '/files/java-worker/' + firstExecuteId + '/classes',
        secondExecuteClassesDir: '/files/java-worker/' + secondExecuteId + '/classes',
        firstExecutePackage: buildPackageName(stableExecuteId),
        secondExecutePackage: buildPackageName(stableExecuteId),
        firstDynamicPath,
        secondDynamicPath,
        firstProjectId,
        secondProjectId
      };
    })()`,
    context
  ) as {
    stableExecuteId: string;
    firstExecuteId: string;
    secondExecuteId: string;
    firstExecuteClassesDir: string;
    secondExecuteClassesDir: string;
    firstExecutePackage: string;
    secondExecutePackage: string;
    firstDynamicPath: string;
    secondDynamicPath: string;
    firstProjectId: string;
    secondProjectId: string;
  };

  assertCondition(result.firstExecuteId !== result.stableExecuteId, 'Java execution id should not expose the stable compile cache seed directly');
  assertCondition(result.firstExecuteId !== result.secondExecuteId, 'Identical Java executions should receive distinct compile ids');
  assertCondition(result.firstExecuteClassesDir !== result.secondExecuteClassesDir, 'Identical Java executions should not reuse writable class directories');
  assertCondition(result.firstExecutePackage === result.secondExecutePackage, 'Java cacheable class names should be content-addressed');
  assertCondition(result.firstDynamicPath === result.secondDynamicPath, 'Serialized Java requests should reuse content-addressed dynamic input paths');
  assertCondition(result.firstProjectId !== result.secondProjectId, 'Identical Java project executions should receive distinct compile ids');
  assertCondition(
    helperSource.includes('assertRestoredCompileCache') &&
      helperSource.includes('compiledOutputManifest(classesDir)') &&
      helperSource.includes('Files.write(target, Files.readAllBytes(path))') &&
      !helperSource.includes('Files.copy(path, target'),
    'Java compiled artifacts should be copied into fresh trees with manifest validation and CheerpJ-compatible byte writes'
  );

  console.log('PASS: Java compile cache uses content-addressed artifacts with fresh request paths');
}

function main(): void {
  assertJavaDeleteOnCloseLiveDeleteContract();
  assertJavaProjectFileReaderDeviceCloseReleasesSuperclass();
  assertJavaLexicalScannersAreCached();
  assertJavaCompileCachePathsArePerExecution();
}

test('java security hardening', main);
