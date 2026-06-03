#!/usr/bin/env npx tsx

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { javaTraceHooksEventsToRuntimeTrace } from '../packages/harness-core/src/trace-adapters/java';
import { createRuntimeCommandStdinPipeFromText } from '../packages/harness-core/src/runtime-project';

interface WorkerMessage {
  id?: string;
  type: string;
  payload?: unknown;
  protocolToken?: string;
}

interface RewriteCall {
  source: string;
  executionStyle: string;
  entryName: string;
  exportsSource: string;
  exportsClassName: string;
  packageName: string;
}

const JAVA_HTTP_SYNC_HEADER_BYTES = 8;
const JAVA_HTTP_SYNC_STATE_INDEX = 0;
const JAVA_HTTP_SYNC_LENGTH_INDEX = 1;
const JAVA_HTTP_SYNC_RESPONSE = 2;

function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function nativeJavaEvent(event: Record<string, unknown>): string {
  return `trace:${JSON.stringify(event)}`;
}

function parseNativeJavaEvent(event: string): Record<string, unknown> | null {
  if (!event.startsWith('trace:')) return null;
  try {
    return JSON.parse(event.slice('trace:'.length)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function nativeEventMatches(event: string, expected: Record<string, unknown>): boolean {
  const parsed = parseNativeJavaEvent(event);
  if (!parsed) return false;
  return Object.entries(expected).every(([key, value]) => JSON.stringify(parsed[key]) === JSON.stringify(value));
}

function latestSourceContaining(files: Array<{ source: string }>, needle: string): string {
  return files.findLast((file) => file.source.includes(needle))?.source ?? '';
}

function javaHttpTestBase64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function writeJavaHttpTestManifest(buffer: SharedArrayBuffer, manifest: string): void {
  const header = new Int32Array(buffer, 0, 2);
  const bytes = new Uint8Array(buffer, JAVA_HTTP_SYNC_HEADER_BYTES);
  const encoded = new TextEncoder().encode(manifest);
  bytes.fill(0);
  bytes.set(encoded.subarray(0, bytes.byteLength));
  Atomics.store(header, JAVA_HTTP_SYNC_LENGTH_INDEX, Math.min(encoded.byteLength, bytes.byteLength));
  Atomics.store(header, JAVA_HTTP_SYNC_STATE_INDEX, JAVA_HTTP_SYNC_RESPONSE);
  Atomics.notify(header, JAVA_HTTP_SYNC_STATE_INDEX);
}

function javaHttpOkTestManifest(status: number, body: string): string {
  return [
    'OK',
    String(status),
    '1',
    `${javaHttpTestBase64('content-type')}\t${javaHttpTestBase64('text/plain')}`,
    javaHttpTestBase64(body),
  ].join('\n');
}

function isJavaHttpTestSharedArrayBuffer(value: unknown): value is SharedArrayBuffer {
  return Object.prototype.toString.call(value) === '[object SharedArrayBuffer]';
}

function rewriteWithNativeJavaRewriter(source: string, entryName = 'solve'): string {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'tracecode-java-rewriter-'));
  try {
    const inputPath = join(tmpRoot, 'Solution.java');
    const exportsPath = join(tmpRoot, 'ExportsHarness.java');
    const outputPath = join(tmpRoot, 'Exports.java');
    writeFileSync(inputPath, source, 'utf8');
    writeFileSync(exportsPath, 'public final class Exports { public static String run() { return "null"; } }', 'utf8');
    execFileSync(
      'java',
      [
        '-cp',
        [
          join(process.cwd(), 'workers', 'vendor', 'java-rewriter.jar'),
          join(process.cwd(), 'workers', 'vendor', 'javaparser-core-3.25.10.jar'),
        ].join(':'),
        'harness.browser.JavaRewriteLibrary',
        inputPath,
        outputPath,
        'solution-method',
        entryName,
        exportsPath,
        'Exports',
        'tracecode.user',
      ],
      { cwd: process.cwd(), stdio: 'pipe' }
    );
    return readFileSync(outputPath, 'utf8');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function assertNativeJavaRewriterCompiles(source: string, entryName = 'solve'): string {
  const rewritten = rewriteWithNativeJavaRewriter(source, entryName);
  const tmpRoot = mkdtempSync(join(tmpdir(), 'tracecode-java-rewriter-compile-'));
  try {
    const sourcePath = join(tmpRoot, 'Exports.java');
    const classesPath = join(tmpRoot, 'classes');
    writeFileSync(sourcePath, rewritten, 'utf8');
    execFileSync('mkdir', ['-p', classesPath]);
    execFileSync(
      'javac',
      [
        '-cp',
        join(process.cwd(), 'workers', 'vendor', 'java-browser-helper.jar'),
        '-d',
        classesPath,
        sourcePath,
      ],
      { cwd: process.cwd(), stdio: 'pipe' }
    );
    return rewritten;
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function executeNativeJavaRewrittenExpression(source: string, expression: string, entryName = 'solve'): string {
  const rewritten = rewriteWithNativeJavaRewriter(source, entryName);
  const tmpRoot = mkdtempSync(join(tmpdir(), 'tracecode-java-rewriter-execute-'));
  try {
    const sourcePath = join(tmpRoot, 'Exports.java');
    const mainPath = join(tmpRoot, 'Main.java');
    const classesPath = join(tmpRoot, 'classes');
    writeFileSync(sourcePath, rewritten, 'utf8');
    writeFileSync(
      mainPath,
      `package tracecode.user;
public final class Main {
  public static void main(String[] args) {
    System.out.println(String.valueOf(${expression}));
  }
}
`,
      'utf8'
    );
    execFileSync('mkdir', ['-p', classesPath]);
    execFileSync(
      'javac',
      [
        '-cp',
        join(process.cwd(), 'workers', 'vendor', 'java-browser-helper.jar'),
        '-d',
        classesPath,
        sourcePath,
        mainPath,
      ],
      { cwd: process.cwd(), stdio: 'pipe' }
    );
    return execFileSync(
      'java',
      ['-cp', [classesPath, join(process.cwd(), 'workers', 'vendor', 'java-browser-helper.jar')].join(':'), 'tracecode.user.Main'],
      { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' }
    ).trim();
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function assertJavaSourceCompiles(source: string, label: string): void {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'tracecode-java-source-compile-'));
  try {
    const publicClassName = source.match(/\bpublic\s+(?:final\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/)?.[1] ?? 'Main';
    const sourcePath = join(tmpRoot, `${publicClassName}.java`);
    const classesPath = join(tmpRoot, 'classes');
    writeFileSync(sourcePath, source, 'utf8');
    execFileSync('mkdir', ['-p', classesPath]);
    execFileSync(
      'javac',
      ['-cp', join(process.cwd(), 'workers', 'vendor', 'java-browser-helper.jar'), '-d', classesPath, sourcePath],
      { cwd: process.cwd(), stdio: 'pipe' }
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} should compile with the Java helper jar: ${detail}`);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function testJavaHelperJarDoesNotExposeDeprecatedSpikePackages(): void {
  const entries = execFileSync('jar', ['tf', join(process.cwd(), 'workers', 'vendor', 'java-browser-helper.jar')], {
    encoding: 'utf8',
  }).split(/\r?\n/);
  assertCondition(
    !entries.some((entry) => entry.startsWith('spike/')),
    'Java helper jar should not expose deprecated spike.* runtime packages'
  );
  console.log('PASS: java helper jar does not expose deprecated spike packages');
}

function loadSourceAugmentationsForTest(): {
  augmentJavaCollectionOperations: (source: string, sourceText?: string) => string;
  augmentJavaLocalSnapshots?: (source: string) => string;
  augmentTraceCallArgumentSnapshots?: (source: string) => string;
} {
  const augmentationSource = readFileSync(join(process.cwd(), 'workers', 'java', 'java-source-augmentations.js'), 'utf8');
  const moduleObject = { exports: {} };
  const context = vm.createContext({
    module: moduleObject,
    exports: moduleObject.exports,
    self: {},
  });
  vm.runInContext(augmentationSource, context, { filename: 'java-source-augmentations.js' });
  return moduleObject.exports as {
    augmentJavaCollectionOperations: (source: string, sourceText?: string) => string;
    augmentJavaLocalSnapshots?: (source: string) => string;
    augmentTraceCallArgumentSnapshots?: (source: string) => string;
  };
}

function augmentRewrittenJavaForTest(source: string, entryName: string): string {
  const augmentations = loadSourceAugmentationsForTest();
  let rewritten = rewriteWithNativeJavaRewriter(source, entryName);
  rewritten = augmentations.augmentTraceCallArgumentSnapshots?.(rewritten) ?? rewritten;
  rewritten = augmentations.augmentJavaCollectionOperations(rewritten, source);
  rewritten = augmentations.augmentJavaLocalSnapshots?.(rewritten) ?? rewritten;
  return rewritten;
}

function testJavaRuntimeValueSerializationLimit(): void {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'tracecode-java-serialization-'));
  try {
    const sourcePath = join(tmpRoot, 'Main.java');
    const classesPath = join(tmpRoot, 'classes');
    writeFileSync(
      sourcePath,
      `import java.util.*;
import tracecode.user.TraceHooks;

public class Main {
  public static void main(String[] args) {
    List<Integer> values = new ArrayList<>();
    for (int i = 0; i < 70; i++) values.add(i);
    Set<Integer> set = new LinkedHashSet<>();
    set.add(1);
    set.add(2);
    Map<String, Integer> map = new LinkedHashMap<>();
    for (int i = 0; i < 70; i++) map.put(String.valueOf(i), i);
    System.out.println(TraceHooks.serializeResult(values));
    System.out.println(TraceHooks.serializeResult(set));
    System.out.println(TraceHooks.serializeResult(map));
    System.out.println(TraceHooks.serializeOutputResult(values));
  }
}
`,
      'utf8'
    );
    execFileSync('mkdir', ['-p', classesPath]);
    execFileSync(
      'javac',
      ['-cp', join(process.cwd(), 'workers', 'vendor', 'java-browser-helper.jar'), '-d', classesPath, sourcePath],
      { cwd: process.cwd(), stdio: 'pipe' }
    );
    const output = execFileSync(
      'java',
      ['-cp', [classesPath, join(process.cwd(), 'workers', 'vendor', 'java-browser-helper.jar')].join(':'), 'Main'],
      { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' }
    );
    const [listJson, setJson, mapJson, outputListJson] = output.trim().split('\n');
    assertCondition(
      listJson.endsWith(',{"__truncated__":true,"remaining":6}]'),
      'Java large lists should serialize first 64 items plus truncation marker'
    );
    assertCondition(
      mapJson.includes('"__truncated__":true,"remaining":6'),
      'Java large maps should serialize truncation fields'
    );
    const setPayload = JSON.parse(setJson) as { __type__?: string; values?: unknown[] };
    assertCondition(
      setPayload.__type__ === 'set' && Array.isArray(setPayload.values) && setPayload.values.join(',') === '1,2',
      'Java sets should serialize as typed set payloads instead of generic arrays'
    );
    const outputList = JSON.parse(outputListJson) as unknown[];
    assertCondition(
      Array.isArray(outputList) && outputList.length === 70 && outputList[69] === 69,
      'Java final output serializer should not use the trace snapshot item cap'
    );
    console.log('PASS: Java runtime value serialization cap');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function testJavaRuntimeUserObjectSerializationIds(): void {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'tracecode-java-user-object-serialization-'));
  try {
    const sourcePath = join(tmpRoot, 'Main.java');
    const classesPath = join(tmpRoot, 'classes');
    writeFileSync(
      sourcePath,
      `package tracecode.user;

class ListNode {
  int val;
  ListNode next;

  ListNode(int val) {
    this.val = val;
  }
}

public class Main {
  public static void main(String[] args) {
    TraceHooks.reset();
    ListNode head = new ListNode(1);
    head.next = new ListNode(2);
    System.out.println(TraceHooks.serializeResult(head));
    System.out.println(TraceHooks.serializeResult(head.next));
    System.out.println(TraceHooks.serializeResult(head));
  }
}
`,
      'utf8'
    );
    execFileSync('mkdir', ['-p', classesPath]);
    execFileSync(
      'javac',
      ['-cp', join(process.cwd(), 'workers', 'vendor', 'java-browser-helper.jar'), '-d', classesPath, sourcePath],
      { cwd: process.cwd(), stdio: 'pipe' }
    );
    const output = execFileSync(
      'java',
      ['-cp', [classesPath, join(process.cwd(), 'workers', 'vendor', 'java-browser-helper.jar')].join(':'), 'tracecode.user.Main'],
      { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' }
    );
    const [headJson, nextJson, headAgainJson] = output.trim().split('\n');
    const head = JSON.parse(headJson) as { __type__?: string; __id__?: string; next?: { __id__?: string; val?: number } };
    const next = JSON.parse(nextJson) as { __type__?: string; __id__?: string; val?: number; next?: unknown };
    const headAgain = JSON.parse(headAgainJson) as { __type__?: string; __id__?: string; next?: { __id__?: string } };

    assertCondition(head.__type__ === 'ListNode', `Java ListNode should serialize as a structured object, received ${headJson}`);
    assertCondition(head.__id__ === 'ListNode:1', `Java ListNode head should receive a stable id, received ${headJson}`);
    assertCondition(
      head.next?.__id__ === 'ListNode:2' && head.next.val === 2,
      `Java nested ListNode should receive its own stable id, received ${headJson}`
    );
    assertCondition(
      next.__id__ === 'ListNode:2' && next.val === 2,
      `Java repeated ListNode serialization should keep the same id, received ${nextJson}`
    );
    assertCondition(
      headAgain.__id__ === 'ListNode:1' && headAgain.next?.__id__ === 'ListNode:2',
      `Java repeated head serialization should keep stable ids, received ${headAgainJson}`
    );
    console.log('PASS: Java runtime serializes tracecode.user objects with stable ids');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function testJavaBrowserHelperWorkspaceDirectories(): void {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'tracecode-java-workspace-dirs-'));
  try {
    const classesPath = join(tmpRoot, 'classes');
    const sourcePath = join(tmpRoot, 'ProjectWorkspaceDirectorySmoke.java');
    writeFileSync(
      sourcePath,
      `import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.StandardOpenOption;
import tracecode.browser.BrowserCompileAndTraceLibrary;
import tracecode.browser.ProjectEvents;

public class ProjectWorkspaceDirectorySmoke {
  public static void main(String[] args) throws Exception {
    Path root = Paths.get(args[0]);
    String manifest = "\\tdir\\tempty/child";
    Method writeProjectResourceFiles = BrowserCompileAndTraceLibrary.class.getDeclaredMethod(
      "writeProjectResourceFiles",
      String.class,
      Path.class);
    writeProjectResourceFiles.setAccessible(true);
    writeProjectResourceFiles.invoke(null, manifest, root);
    Method collectChangedProjectFilesJson = BrowserCompileAndTraceLibrary.class.getDeclaredMethod(
      "collectChangedProjectFilesJson",
      Path.class,
      String.class);
    collectChangedProjectFilesJson.setAccessible(true);
    System.out.println(Files.isDirectory(root.resolve("empty/child")));
    System.out.println(collectChangedProjectFilesJson.invoke(null, root, manifest));
    String kernelManifest = "/proc/kernel/version\\t" + java.util.Base64.getEncoder().encodeToString("kernel".getBytes(java.nio.charset.StandardCharsets.UTF_8));
    System.out.println(collectChangedProjectFilesJson.invoke(null, root, kernelManifest));
    ProjectEvents.setKernelDevices("L2Rldi9zdGRpbg==\\tMQ==\\t\\tL2Rldi9zdGRpbg==\\t");
    try (var channel = ProjectEvents.newByteChannel(Paths.get("/dev/stdin"), StandardOpenOption.READ)) {
      ByteBuffer bytes = ByteBuffer.allocate(64);
      channel.read(bytes);
      bytes.flip();
      System.out.println(StandardCharsets.UTF_8.decode(bytes).toString().trim());
    } finally {
      ProjectEvents.clearKernelDevices();
    }
    ProjectEvents.setKernelDevices("L2Rldi9jdXN0b20taW4=\\tMQ==\\tMA==\\tL2Rldi9jdXN0b20tc291cmNl\\t");
    try {
      System.out.println(ProjectEvents.readString(Paths.get("/dev/custom-in")).trim());
    } finally {
      ProjectEvents.clearKernelDevices();
    }
    java.util.function.Function<String, String> b64 = (value) -> java.util.Base64.getEncoder().encodeToString(value.getBytes(StandardCharsets.UTF_8));
    java.util.function.Function<String[], String> device = (fields) ->
      b64.apply(fields[0]) + "\t" + b64.apply(fields[1]) + "\t" + b64.apply(fields[2]) + "\t" + b64.apply(fields[3]) + "\t" + b64.apply(fields[4]);
    java.io.InputStream previousIn = System.in;
    ProjectEvents.setKernelDevices(String.join("\\n",
      device.apply(new String[] { "/dev/stdin", "1", "0", "/dev/stdin", "" }),
      device.apply(new String[] { "/dev/tty", "1", "1", "/dev/stdin", "/dev/stdout" }),
      device.apply(new String[] { "/dev/custom-in", "1", "0", "/dev/stdin", "" })
    ));
    try {
      System.setIn(ProjectEvents.inputStream());
      int systemByte = System.in.read();
      int streamByte;
      try (var stream = new ProjectEvents.ProjectFileInputStream("/dev/stdin")) {
        streamByte = stream.read();
      }
      int readerChar;
      try (var reader = new ProjectEvents.ProjectFileReader("/dev/custom-in", StandardCharsets.UTF_8)) {
        readerChar = reader.read();
      }
      String ttyRest = ProjectEvents.readString(Paths.get("/dev/tty"));
      String customRest = ProjectEvents.readString(Paths.get("/dev/custom-in"));
      System.out.println("shared-stdin=" + systemByte + ":" + streamByte + ":" + readerChar + ":" + ttyRest + ":" + customRest);
    } finally {
      System.setIn(previousIn);
      ProjectEvents.clearKernelDevices();
    }
    ProjectEvents.setKernelDevices(String.join("\\n",
      device.apply(new String[] { "/dev/stdin", "1", "0", "/dev/stdin", "" }),
      device.apply(new String[] { "/dev/null", "1", "1", "/dev/null", "/dev/null" }),
      device.apply(new String[] { "/dev/stdout", "0", "1", "", "/dev/stdout" }),
      device.apply(new String[] { "/dev/tty", "1", "1", "/dev/stdin", "/dev/stdout" }),
      device.apply(new String[] { "/dev/log", "0", "1", "", "/dev/stderr" })
    ));
    try {
      var stdoutCapture = new java.io.ByteArrayOutputStream();
      var stderrCapture = new java.io.ByteArrayOutputStream();
      ProjectEvents.streamingOutput(stdoutCapture, "stdout");
      ProjectEvents.streamingOutput(stderrCapture, "stderr");
      String fileDescriptorReaderInput;
      try (var reader = new ProjectEvents.ProjectFileReader(java.io.FileDescriptor.in)) {
        char[] buffer = new char[64];
        int read = reader.read(buffer);
        fileDescriptorReaderInput = read < 0 ? "" : new String(buffer, 0, read).trim();
      }
      try (var writer = new ProjectEvents.ProjectFileWriter("/dev/stdout", StandardCharsets.UTF_8)) {
        writer.write("file-writer-out\\n");
      }
      try (var writer = new ProjectEvents.ProjectPrintWriter("/dev/stdout", StandardCharsets.UTF_8)) {
        writer.print("print-writer-out\\n");
      }
      try (var writer = new ProjectEvents.ProjectFileWriter("/dev/tty", StandardCharsets.UTF_8)) {
        writer.write("tty-writer-out\\n");
      }
      try (var writer = new ProjectEvents.ProjectPrintWriter("/dev/log", StandardCharsets.UTF_8)) {
        writer.print("print-writer-err\\n");
      }
      System.out.println(stdoutCapture.toString("UTF-8").replace("\\n", "|") + stderrCapture.toString("UTF-8").replace("\\n", "|"));
      System.out.println("fd-reader=" + fileDescriptorReaderInput);
      var devDir = new ProjectEvents.ProjectFile("/dev");
      var stdoutDevice = new ProjectEvents.ProjectFile("/dev/stdout");
      var stdinDevice = new ProjectEvents.ProjectFile("/dev/stdin");
      var missingDevice = new ProjectEvents.ProjectFile("/dev/missing");
      boolean stdoutSetLastModified = stdoutDevice.setLastModified(1L);
      boolean stdoutSetWritable = stdoutDevice.setWritable(true);
      boolean devDirSetReadable = devDir.setReadable(false);
      var listedDevices = devDir.list();
      java.util.Arrays.sort(listedDevices);
      var filteredDevices = devDir.list((dir, name) -> name.contains("out") || name.contains("err"));
      java.util.Arrays.sort(filteredDevices);
      var listedFiles = devDir.listFiles(file -> file.isFile() && file.canWrite());
      java.util.ArrayList<String> writableFileNames = new java.util.ArrayList<>();
      for (var file : listedFiles) writableFileNames.add(file.getName());
      java.util.Collections.sort(writableFileNames);
      System.out.println("file-api="
        + devDir.exists() + ":" + devDir.isDirectory() + ":" + devDir.canRead() + ":" + devDir.canWrite()
        + ":" + stdoutDevice.exists() + ":" + stdoutDevice.isFile() + ":" + stdoutDevice.canRead() + ":" + stdoutDevice.canWrite()
        + ":" + stdinDevice.canRead() + ":" + stdinDevice.canWrite()
        + ":" + missingDevice.exists() + ":" + missingDevice.isFile() + ":" + stdoutDevice.length()
        + ":" + stdoutSetLastModified + ":" + stdoutSetWritable + ":" + devDirSetReadable
        + ":" + String.join(",", listedDevices)
        + ":" + String.join(",", filteredDevices)
        + ":" + String.join(",", writableFileNames));
      String kernelFileManifest = b64.apply("/tracekernel/custom") + "\t" + b64.apply("custom-kernel-file\\n");
      ProjectEvents.setKernelFiles(kernelFileManifest);
      String devNioSetLastModifiedResult = "ok";
      try {
        ProjectEvents.setLastModifiedTime(Paths.get("/dev/stdout"), java.nio.file.attribute.FileTime.fromMillis(1L));
      } catch (java.io.IOException ex) {
        devNioSetLastModifiedResult = ex.getClass().getSimpleName();
      }
      String customKernelNioSetAttributeResult = "ok";
      try {
        ProjectEvents.setAttribute(Paths.get("/tracekernel/custom"), "basic:lastModifiedTime", java.nio.file.attribute.FileTime.fromMillis(1L));
      } catch (java.io.IOException ex) {
        customKernelNioSetAttributeResult = ex.getClass().getSimpleName();
      }
      System.out.println("nio-stat-api="
        + ProjectEvents.isReadable(Paths.get("/dev")) + ":" + ProjectEvents.isWritable(Paths.get("/dev"))
        + ":" + ProjectEvents.isReadable(Paths.get("/dev/stdin")) + ":" + ProjectEvents.isWritable(Paths.get("/dev/stdin"))
        + ":" + ProjectEvents.isReadable(Paths.get("/dev/stdout")) + ":" + ProjectEvents.isWritable(Paths.get("/dev/stdout"))
        + ":" + ProjectEvents.size(Paths.get("/dev/stdout"))
        + ":" + ProjectEvents.isReadable(Paths.get("/tracekernel")) + ":" + ProjectEvents.isWritable(Paths.get("/tracekernel"))
        + ":" + ProjectEvents.isReadable(Paths.get("/tracekernel/custom")) + ":" + ProjectEvents.isWritable(Paths.get("/tracekernel/custom"))
        + ":" + ProjectEvents.size(Paths.get("/tracekernel")) + ":" + ProjectEvents.size(Paths.get("/tracekernel/custom"))
        + ":" + ProjectEvents.isReadable(Paths.get("/tracekernel/missing"))
        + ":" + devNioSetLastModifiedResult + ":" + customKernelNioSetAttributeResult);
      var customKernelFile = new ProjectEvents.ProjectFile("/tracekernel/custom");
      var customKernelDir = new ProjectEvents.ProjectFile("/tracekernel");
      boolean customKernelSetLastModified = customKernelFile.setLastModified(1L);
      boolean customKernelSetWritable = customKernelFile.setWritable(true);
      boolean customKernelDirSetReadable = customKernelDir.setReadable(false);
      var customKernelRootEntries = customKernelDir.list();
      java.util.Arrays.sort(customKernelRootEntries);
      String customKernelReadString = ProjectEvents.readString(Paths.get("/tracekernel/custom"));
      String customKernelReadBytes = new String(ProjectEvents.readAllBytes(Paths.get("/tracekernel/custom")), StandardCharsets.UTF_8);
      String customKernelReader;
      try (var reader = new ProjectEvents.ProjectFileReader("/tracekernel/custom", StandardCharsets.UTF_8)) {
        char[] buffer = new char[64];
        customKernelReader = new String(buffer, 0, reader.read(buffer));
      }
      String customKernelChannel;
      try (var channel = ProjectEvents.newByteChannel(Paths.get("/tracekernel/custom"), StandardOpenOption.READ)) {
        ByteBuffer buffer = ByteBuffer.allocate(64);
        channel.read(buffer);
        buffer.flip();
        customKernelChannel = StandardCharsets.UTF_8.decode(buffer).toString();
      }
      java.util.ArrayList<String> listedKernelPaths = new java.util.ArrayList<>();
      try (var stream = ProjectEvents.list(Paths.get("/tracekernel"))) {
        stream.forEach(path -> listedKernelPaths.add(path.toString()));
      }
      java.util.Collections.sort(listedKernelPaths);
      String customFileWriterResult = "ok";
      try {
        new ProjectEvents.ProjectFileWriter("/tracekernel/custom", StandardCharsets.UTF_8).close();
      } catch (java.io.IOException ex) {
        customFileWriterResult = ex.getClass().getSimpleName();
      }
      String customKernelMkdirResult = "ok";
      try {
        ProjectEvents.createDirectories(Paths.get("/tracekernel/new"));
      } catch (java.io.IOException ex) {
        customKernelMkdirResult = ex.getClass().getSimpleName();
      }
      Path tempRoot = root.resolve("temp-root");
      ProjectEvents.createDirectories(tempRoot);
      Path tempFile = ProjectEvents.createTempFile(tempRoot, "case", ".txt");
      ProjectEvents.writeString(tempFile, "temp-created\\n");
      java.io.File fileApiTempFile = ProjectEvents.createTempFile("iot", ".tmp", tempRoot.toFile());
      ProjectEvents.writeString(fileApiTempFile.toPath(), "file-temp-created\\n");
      Path tempDir = ProjectEvents.createTempDirectory(tempRoot, "child");
      System.out.println("temp-api="
        + tempFile.getParent().equals(tempRoot) + ":" + Files.exists(tempFile) + ":" + Files.readString(tempFile).replace("\\n", "|")
        + ":" + fileApiTempFile.getParentFile().toPath().equals(tempRoot) + ":" + fileApiTempFile.isFile() + ":" + Files.readString(fileApiTempFile.toPath()).replace("\\n", "|")
        + ":" + tempDir.getParent().equals(tempRoot) + ":" + Files.isDirectory(tempDir));
      System.out.println("kernel-file-api="
        + customKernelDir.exists() + ":" + customKernelDir.isDirectory() + ":" + customKernelDir.canRead() + ":" + customKernelDir.canWrite()
        + ":" + customKernelFile.exists() + ":" + customKernelFile.isFile() + ":" + customKernelFile.canRead() + ":" + customKernelFile.canWrite()
        + ":" + customKernelFile.length() + ":" + customKernelSetLastModified + ":" + customKernelSetWritable + ":" + customKernelDirSetReadable
        + ":" + String.join(",", customKernelRootEntries)
        + ":" + customKernelReadString.replace("\\n", "|")
        + ":" + customKernelReadBytes.replace("\\n", "|")
        + ":" + customKernelReader.replace("\\n", "|")
        + ":" + customKernelChannel.replace("\\n", "|")
        + ":" + String.join(",", listedKernelPaths)
        + ":" + customFileWriterResult + ":" + customKernelMkdirResult);
    } finally {
      ProjectEvents.clearKernelDevices();
    }
  }
}
`,
      'utf8'
    );
    execFileSync('mkdir', ['-p', classesPath]);
    execFileSync(
      'javac',
      ['-cp', join(process.cwd(), 'workers', 'vendor', 'java-browser-helper.jar'), '-d', classesPath, sourcePath],
      { cwd: process.cwd(), stdio: 'pipe' }
    );
    const output = execFileSync(
      'java',
      [
        '-cp',
        [classesPath, join(process.cwd(), 'workers', 'vendor', 'java-browser-helper.jar')].join(':'),
        'ProjectWorkspaceDirectorySmoke',
        tmpRoot,
      ],
      { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' }
    );
    const [
      isDirectory,
      changedFilesJson,
      kernelChangedFilesJson,
      deviceChannelInput,
      customDeviceInput,
      sharedStdinOutput,
      deviceWriterOutput,
      fileDescriptorReaderOutput,
      fileApiOutput,
      nioStatApiOutput,
      tempApiOutput,
      kernelFileApiOutput,
    ] = output.trim().split('\n');
    assertCondition(isDirectory === 'true', `Java browser helper should materialize workspace directories: ${output}`);
    assertCondition(
      Array.isArray(JSON.parse(changedFilesJson ?? 'null')) && JSON.parse(changedFilesJson ?? 'null').length === 0,
      'Java browser helper should not report directory manifest entries as file changes'
    );
    assertCondition(
      Array.isArray(JSON.parse(kernelChangedFilesJson ?? 'null')) && JSON.parse(kernelChangedFilesJson ?? 'null').length === 0,
      'Java browser helper should not report kernel virtual manifest entries as workspace deletions'
    );
    assertCondition(
      deviceChannelInput === '',
      `Java browser helper should expose EOF for stdin without a live host pipe through newByteChannel: ${output}`
    );
    assertCondition(
      customDeviceInput === '',
      `Java browser helper should expose EOF for custom input devices without a live host pipe: ${output}`
    );
    assertCondition(
      sharedStdinOutput === 'shared-stdin=-1:-1:-1::',
      `Java browser helper should route System.in and device inputs through live host input only: ${output}`
    );
    assertCondition(
      deviceWriterOutput === 'file-writer-out|print-writer-out|tty-writer-out|print-writer-err|',
      `Java browser helper should route FileWriter and PrintWriter through kernel devices: ${output}`
    );
    assertCondition(
      fileDescriptorReaderOutput === 'fd-reader=',
      `Java browser helper should expose EOF for FileReader(FileDescriptor.in) without a live host pipe: ${output}`
    );
    assertCondition(
      fileApiOutput === 'file-api=true:true:true:false:true:true:false:true:true:false:false:false:0:false:false:false:log,null,stdin,stdout,tty:stdout:log,null,stdout,tty',
      `Java browser helper should route java.io.File metadata/listing through kernel devices: ${output}`
    );
    assertCondition(
      nioStatApiOutput === 'nio-stat-api=true:false:true:false:false:true:0:true:false:true:false:0:19:false:IOException:IOException',
      `Java browser helper should route NIO metadata probes through kernel virtual paths: ${output}`
    );
    assertCondition(
      tempApiOutput === 'temp-api=true:true:temp-created|:true:true:file-temp-created|:true:true',
      `Java browser helper should create temp files/directories through ProjectEvents: ${output}`
    );
    assertCondition(
      kernelFileApiOutput === 'kernel-file-api=true:true:true:false:true:true:true:false:19:false:false:false:custom:custom-kernel-file|:custom-kernel-file|:custom-kernel-file|:custom-kernel-file|:/tracekernel/custom:IOException:IOException',
      `Java browser helper should expose manifest kernel files as read-only File API paths: ${output}`
    );
    const projectEventsSource = readFileSync(
      join(process.cwd(), 'workers', 'java', 'src', 'tracecode', 'browser', 'ProjectEvents.java'),
      'utf8'
    );
    assertCondition(
        /ProjectFileOutputStream[\s\S]*super\.write\(value\);\s*emitFileSnapshot\(path\);/.test(projectEventsSource) &&
        /ProjectFileOutputStream[\s\S]*this\.device = kernelDevice\(this\.path\);\s*emitOpenSnapshot\(false\);/.test(projectEventsSource) &&
        /ProjectFileWriter[\s\S]*this\.charset = Charset\.defaultCharset\(\);\s*emitOpenSnapshot\(false\);/.test(projectEventsSource) &&
        /ProjectFileOutputStream[\s\S]*super\.write\(bytes\);\s*emitFileSnapshot\(path\);/.test(projectEventsSource) &&
        /ProjectOutputStream[\s\S]*delegate\.write\(bytes, offset, length\);\s*emitFileSnapshot\(path\);/.test(projectEventsSource) &&
        /ProjectPrintWriter[\s\S]*super\.write\(text, offset, length\);\s*emitAfterWrite\(\);/.test(projectEventsSource) &&
        /ProjectBufferedWriter[\s\S]*super\.write\(text, offset, length\);\s*emitAfterWrite\(\);/.test(projectEventsSource) &&
        /createTempFile[\s\S]*emitFileSnapshot\(result\);/.test(projectEventsSource) &&
        /File createTempFile\(String prefix, String suffix, File directory\)[\s\S]*emitFileSnapshot\(result\.toPath\(\)\);/.test(projectEventsSource) &&
        /createTempDirectory[\s\S]*emitDirectoryCreate\(result\);/.test(projectEventsSource) &&
        /StreamingProjectOutputStream[\s\S]*write\(int value\)[\s\S]*pending\.write\(value\);\s*flush\(\);/.test(projectEventsSource) &&
        /StreamingProjectOutputStream[\s\S]*write\(byte\[\] bytes, int offset, int length\)[\s\S]*pending\.write\(bytes, offset, length\);\s*flush\(\);/.test(projectEventsSource),
      'Java browser helper should emit live file snapshots and unbuffered stdio write events'
    );
    console.log('PASS: Java browser helper materializes workspace directories');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function testJavaProjectEventsRandomAccessKernelReads(): void {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'tracecode-java-kernel-random-access-'));
  try {
    const classesPath = join(tmpRoot, 'classes');
    const sourcePath = join(tmpRoot, 'ProjectEventsRandomAccessSmoke.java');
    writeFileSync(
      sourcePath,
      `import java.nio.charset.StandardCharsets;
import tracecode.browser.ProjectEvents;

public class ProjectEventsRandomAccessSmoke {
  public static void main(String[] args) throws Exception {
    java.util.function.Function<String, String> b64 =
      (value) -> java.util.Base64.getEncoder().encodeToString(value.getBytes(StandardCharsets.UTF_8));
    java.util.function.Function<String[], String> device = (fields) ->
      b64.apply(fields[0]) + "\\t" + b64.apply(fields[1]) + "\\t" + b64.apply(fields[2]) + "\\t" + b64.apply(fields[3]) + "\\t" + b64.apply(fields[4]);
    ProjectEvents.setKernelDevices(device.apply(new String[] { "/dev/stdin", "1", "0", "/dev/stdin", "" }));
    ProjectEvents.setKernelFiles(b64.apply("/tracekernel/custom") + "\\t" + b64.apply("custom-kernel-file\\n"));
    try {
      System.out.println("custom-random=" + readRandom("/tracekernel/custom").trim());
      System.out.println("stdin-random=" + readRandom("/dev/stdin").trim());
      try {
        new ProjectEvents.ProjectRandomAccessFile("/tracekernel/custom", "rw").close();
        System.out.println("custom-rw=ok");
      } catch (java.io.IOException ex) {
        System.out.println("custom-rw=" + ex.getClass().getSimpleName());
      }
    } finally {
      ProjectEvents.clearKernelDevices();
    }
  }

  private static String readRandom(String path) throws Exception {
    try (var random = new ProjectEvents.ProjectRandomAccessFile(path, "r")) {
      byte[] buffer = new byte[(int) random.length()];
      random.readFully(buffer);
      return new String(buffer, StandardCharsets.UTF_8);
    }
  }
}
`,
      'utf8'
    );
    execFileSync('mkdir', ['-p', classesPath]);
    execFileSync(
      'javac',
      [
        '-d',
        classesPath,
        sourcePath,
        join(process.cwd(), 'workers', 'java', 'src', 'tracecode', 'browser', 'ProjectEvents.java'),
      ],
      { cwd: process.cwd(), stdio: 'pipe' }
    );
    const output = execFileSync('java', ['-cp', classesPath, 'ProjectEventsRandomAccessSmoke'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: 'pipe',
    });
    assertCondition(
      output.trim() === 'custom-random=custom-kernel-file\nstdin-random=\ncustom-rw=IOException',
      `Java ProjectEvents should route RandomAccessFile through kernel reads: ${output}`
    );
    console.log('PASS: Java ProjectEvents RandomAccessFile kernel reads');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function testJavaProjectEventsHttpClientShims(): void {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'tracecode-java-http-smoke-'));
  try {
    const sourcePath = join(tmpRoot, 'ProjectEventsHttpSmoke.java');
    const classesPath = join(tmpRoot, 'classes');
    writeFileSync(
      sourcePath,
      `import tracecode.browser.ProjectEvents;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URL;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import com.sun.net.httpserver.HttpServer;

public class ProjectEventsHttpSmoke {
  static String b64(String value) {
    return Base64.getEncoder().encodeToString(value.getBytes(StandardCharsets.UTF_8));
  }

  static String response(int status, String mode, String body) {
    return String.join("\\n",
      "OK",
      Integer.toString(status),
      "2",
      b64("content-type") + "\\t" + b64("text/plain"),
      b64("x-mode") + "\\t" + b64(mode),
      b64(body)
    );
  }

  public static void main(String[] args) throws Exception {
    List<String> requests = new ArrayList<>();
    ProjectEvents.setHttpDispatcherForTesting((requestJson) -> {
      requests.add(requestJson);
      if (requestJson.contains("/async")) return response(203, "async-mode", "async-body");
      if (requestJson.contains("/proxy-upstream")) return response(206, "proxy-mode", "upstream-body");
      if (requestJson.contains("/post")) return response(202, "client-mode", "client-body");
      return response(201, "url-mode", "url-body");
    });

    ProjectEvents.installHttpUrlHandler();
    HttpURLConnection connection = (HttpURLConnection) new URL("http://tracekernel.test/items?limit=1").openConnection();
    connection.setReadTimeout(1234);
    connection.setRequestProperty("accept", "text/plain");
    String urlBody = new String(connection.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
    System.out.println("url=" + connection.getResponseCode() + ":" + urlBody + ":" + connection.getHeaderField("x-mode"));

    HttpClient client = ProjectEvents.httpClientBuilder().version(HttpClient.Version.HTTP_1_1).build();
    HttpRequest post = HttpRequest.newBuilder(URI.create("http://tracekernel.test/post"))
      .header("content-type", "text/plain")
      .timeout(Duration.ofMillis(2345))
      .POST(HttpRequest.BodyPublishers.ofString("job"))
      .build();
    HttpResponse<String> postResponse = client.send(post, HttpResponse.BodyHandlers.ofString());
    System.out.println("client=" + postResponse.statusCode() + ":" + postResponse.body() + ":" + postResponse.headers().firstValue("x-mode").orElse(""));

    HttpRequest asyncRequest = HttpRequest.newBuilder(URI.create("http://tracekernel.test/async")).GET().build();
    HttpResponse<String> asyncResponse = ProjectEvents.httpClient().sendAsync(asyncRequest, HttpResponse.BodyHandlers.ofString()).join();
    System.out.println("async=" + asyncResponse.statusCode() + ":" + asyncResponse.body());

    HttpServer server = ProjectEvents.httpServer(new InetSocketAddress("127.0.0.1", 0), 0);
    server.createContext("/queue", (exchange) -> {
      String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
      byte[] response = ("handled:" + exchange.getRequestMethod() + ":" + exchange.getRequestURI().getRawQuery() + ":" + body).getBytes(StandardCharsets.UTF_8);
      exchange.getResponseHeaders().set("x-server", "project");
      exchange.sendResponseHeaders(207, response.length);
      exchange.getResponseBody().write(response);
      exchange.close();
    });
    server.createContext("/proxy", (exchange) -> {
      String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
      HttpRequest upstreamRequest = HttpRequest.newBuilder(URI.create("http://tracekernel.test/proxy-upstream"))
        .header("content-type", "text/plain")
        .POST(HttpRequest.BodyPublishers.ofString(body + ":via-java-server"))
        .build();
      HttpResponse<String> upstreamResponse;
      try {
        upstreamResponse = ProjectEvents.httpClient().send(upstreamRequest, HttpResponse.BodyHandlers.ofString());
      } catch (InterruptedException error) {
        Thread.currentThread().interrupt();
        throw new IOException("upstream interrupted", error);
      }
      byte[] response = ("proxy:" + upstreamResponse.statusCode() + ":" + upstreamResponse.body()).getBytes(StandardCharsets.UTF_8);
      exchange.getResponseHeaders().set("x-server", "java-proxy");
      exchange.sendResponseHeaders(208, response.length);
      exchange.getResponseBody().write(response);
      exchange.close();
    });
    server.start();
    HttpRequest serverRequest = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/queue?id=7"))
      .POST(HttpRequest.BodyPublishers.ofString("work"))
      .build();
    HttpResponse<String> serverResponse = ProjectEvents.httpClient().send(serverRequest, HttpResponse.BodyHandlers.ofString());
    System.out.println("server=" + serverResponse.statusCode() + ":" + serverResponse.body() + ":" + serverResponse.headers().firstValue("x-server").orElse(""));
    HttpRequest serverProxyRequest = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/proxy"))
      .POST(HttpRequest.BodyPublishers.ofString("bridge"))
      .build();
    HttpResponse<String> serverProxyResponse = ProjectEvents.httpClient().send(serverProxyRequest, HttpResponse.BodyHandlers.ofString());
    System.out.println("server-client=" + serverProxyResponse.statusCode() + ":" + serverProxyResponse.body() + ":" + serverProxyResponse.headers().firstValue("x-server").orElse(""));
    server.stop(0);

    System.out.println("requests=" + requests.size());
    for (String request : requests) {
      System.out.println("request=" + request);
    }
  }
}
`,
      'utf8'
    );
    execFileSync('mkdir', ['-p', classesPath]);
    execFileSync(
      'javac',
      ['-cp', join(process.cwd(), 'workers', 'vendor', 'java-browser-helper.jar'), '-d', classesPath, sourcePath],
      { cwd: process.cwd(), stdio: 'pipe' }
    );
    const output = execFileSync(
      'java',
      ['-cp', [classesPath, join(process.cwd(), 'workers', 'vendor', 'java-browser-helper.jar')].join(':'), 'ProjectEventsHttpSmoke'],
      { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' }
    );
    assertCondition(output.includes('url=201:url-body:url-mode'), `Java URLConnection shim should dispatch TraceKernel HTTP: ${output}`);
    assertCondition(output.includes('client=202:client-body:client-mode'), `Java HttpClient.send shim should dispatch TraceKernel HTTP: ${output}`);
    assertCondition(output.includes('async=203:async-body'), `Java HttpClient.sendAsync shim should dispatch TraceKernel HTTP: ${output}`);
    assertCondition(output.includes('server=207:handled:POST:id=7:work:project'), `Java HttpServer shim should handle local TraceKernel HTTP clients: ${output}`);
    assertCondition(output.includes('server-client=208:proxy:206:upstream-body:java-proxy'), `Java HttpServer handlers should dispatch TraceKernel HTTP clients before responding: ${output}`);
    assertCondition(output.includes('requests=4'), `Java HTTP shims should dispatch four requests: ${output}`);
    assertCondition(
      output.includes('"path":"/items?limit=1"') &&
        output.includes('"_tracekernelTimeoutMs":1234') &&
        output.includes('"_tracekernelTimeoutMs":2345') &&
        output.includes('"method":"POST"') &&
        output.includes('"body":"am9i"') &&
        output.includes('"path":"/async"') &&
        output.includes('"path":"/proxy-upstream"') &&
        output.includes('"body":"YnJpZGdlOnZpYS1qYXZhLXNlcnZlcg=="'),
      `Java HTTP shims should preserve paths, methods, and request bodies: ${output}`
    );
    console.log('PASS: Java ProjectEvents HTTP client shims dispatch through TraceKernel bridge');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function testJavaRuntimeMultiSnapshotFragments(): void {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'tracecode-java-multi-snapshot-'));
  try {
    const sourcePath = join(tmpRoot, 'Main.java');
    const classesPath = join(tmpRoot, 'classes');
    writeFileSync(
      sourcePath,
      `import tracecode.user.TraceHooks;

public class Main {
  public static void main(String[] args) {
    TraceHooks.reset();
    TraceHooks.emitLineAtLine(1, " nums=[1,2] target=2");
    TraceHooks.emitCallAtLine(2, "search", " nums=[1,2] target=2");
    for (String event : TraceHooks.drainEvents()) System.out.println(event);
  }
}
`,
      'utf8'
    );
    execFileSync('mkdir', ['-p', classesPath]);
    execFileSync(
      'javac',
      ['-cp', join(process.cwd(), 'workers', 'vendor', 'java-browser-helper.jar'), '-d', classesPath, sourcePath],
      { cwd: process.cwd(), stdio: 'pipe' }
    );
    const output = execFileSync(
      'java',
      ['-cp', [classesPath, join(process.cwd(), 'workers', 'vendor', 'java-browser-helper.jar')].join(':'), 'Main'],
      { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' }
    );
    const events = output.trim().split('\n');
    const trace = javaTraceHooksEventsToRuntimeTrace(events, undefined, { runId: 'java:test' });
    assertCondition(
      trace.events.some((event) =>
        event.kind === 'call' &&
        event.line === 2 &&
        JSON.stringify(event.args) === JSON.stringify({ nums: [1, 2], target: 2 })
      ),
      'Java call hooks should convert live argument fragments into native JSON args'
    );
    assertCondition(
      trace.events.some((event) =>
        event.kind === 'snapshot' &&
        event.line === 1 &&
        'variable' in event.target &&
        event.target.variable === 'nums' &&
        JSON.stringify(event.value) === JSON.stringify([1, 2])
      ) &&
        trace.events.some((event) =>
          event.kind === 'snapshot' &&
          event.line === 2 &&
          'variable' in event.target &&
          event.target.variable === 'target' &&
          event.value === 2
        ),
      'Java line/call hooks should split multi-variable live fragments into native snapshot events'
    );
    console.log('PASS: Java native hooks split multi-variable live snapshots');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function testJavaEnhancedForHeaderExpansionDropsStaleBindingSnapshots(): void {
  const source = `class Solution {
  int solve(Object[][] rates) {
    for (Object[] rate : rates) {
      int len = rate.length;
    }
    return 0;
  }
}`;
  const trace = javaTraceHooksEventsToRuntimeTrace(
    [
      nativeJavaEvent({ kind: 'snapshot', line: 4, target: { variable: 'rate' }, value: ['USD', 'EUR', 0.9] }),
      nativeJavaEvent({
        kind: 'read',
        line: 3,
        target: { variable: 'rates', path: [1] },
        value: ['EUR', 'USD', 1.1],
        binding: { kind: 'iteration', variable: 'rate' },
      }),
      nativeJavaEvent({ kind: 'line', line: 4 }),
      nativeJavaEvent({ kind: 'snapshot', line: 4, target: { variable: 'rate' }, value: ['EUR', 'USD', 1.1] }),
    ],
    source,
    { runId: 'java:test' }
  );
  const headerRateSnapshots = trace.events.filter(
    (event) =>
      event.kind === 'snapshot' &&
      event.line === 3 &&
      'variable' in event.target &&
      event.target.variable === 'rate'
  );
  assertCondition(
    headerRateSnapshots.length === 1 &&
      JSON.stringify(headerRateSnapshots[0]?.value) === JSON.stringify(['EUR', 'USD', 1.1]),
    `Java enhanced-for header expansion should keep only the current binding snapshot, received ${JSON.stringify(headerRateSnapshots)}`
  );
  console.log('PASS: Java enhanced-for header expansion drops stale binding snapshots');
}

function testJavaRuntimeRecursiveCallStacks(): void {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'tracecode-java-recursive-callstack-'));
  try {
    const sourcePath = join(tmpRoot, 'Main.java');
    const classesPath = join(tmpRoot, 'classes');
    writeFileSync(
      sourcePath,
      `import tracecode.user.TraceHooks;

public class Main {
  static int dfs(Integer node) {
    TraceHooks.emitCallAtLine(4, "dfs", "" + " node=" + TraceHooks.serializeResult(node));
    TraceHooks.emitLineAtLine(5, "" + " node=" + TraceHooks.serializeResult(node));
    if (node == null) {
      TraceHooks.emitReturnAtLine(6, "dfs", 0);
      return 0;
    }
    int child = dfs(null);
    TraceHooks.emitScalarWriteAtLine(9, "child", child);
    TraceHooks.emitReturnAtLine(10, "dfs", node);
    return node;
  }

  public static void main(String[] args) {
    TraceHooks.reset();
    dfs(2);
    for (String event : TraceHooks.drainEvents()) System.out.println(event);
  }
}
`,
      'utf8'
    );
    execFileSync('mkdir', ['-p', classesPath]);
    execFileSync(
      'javac',
      ['-cp', join(process.cwd(), 'workers', 'vendor', 'java-browser-helper.jar'), '-d', classesPath, sourcePath],
      { cwd: process.cwd(), stdio: 'pipe' }
    );
    const output = execFileSync(
      'java',
      ['-cp', [classesPath, join(process.cwd(), 'workers', 'vendor', 'java-browser-helper.jar')].join(':'), 'Main'],
      { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' }
    );
    const parsed = output.trim().split('\n').map(parseNativeJavaEvent).filter((event): event is Record<string, unknown> => Boolean(event));
    const lineFiveEvents = parsed.filter((event) => event.kind === 'line' && event.line === 5);
    assertCondition(lineFiveEvents.length === 2, 'Java recursive trace should emit both same-source-line dfs frames');
    assertCondition(
      lineFiveEvents.some((event) => JSON.stringify(event.callStack).includes('"args":{"node":2}')) &&
        lineFiveEvents.some((event) => JSON.stringify(event.callStack).includes('"args":{"node":null}')),
      `Java recursive same-line events should carry frame-specific callStack args, received ${JSON.stringify(lineFiveEvents)}`
    );
    const childWrite = parsed.find((event) => event.kind === 'write' && event.line === 9 && JSON.stringify(event.target) === JSON.stringify({ variable: 'child' }));
    assertCondition(
      Boolean(childWrite) &&
        JSON.stringify(childWrite?.callStack).includes('"args":{"node":2}') &&
        !JSON.stringify(childWrite?.callStack).includes('"args":{"node":null}'),
      `Java post-recursion write should be scoped back to the parent frame, received ${JSON.stringify(childWrite)}`
    );
    console.log('PASS: Java native hooks emit frame-specific recursive call stacks');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function testJavaRuntimeMutationHooksEmitPostSnapshots(): void {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'tracecode-java-mutation-snapshots-'));
  try {
    const sourcePath = join(tmpRoot, 'Main.java');
    const classesPath = join(tmpRoot, 'classes');
    writeFileSync(
      sourcePath,
      `import java.util.*;
import tracecode.user.TraceHooks;

class Node {
  Map<Character, Node> children = new HashMap<>();
  boolean isEnd = false;
}

public class Main {
  public static void main(String[] args) {
    TraceHooks.reset();
    Map<Integer, Integer> freq = new HashMap<>();
    TraceHooks.emitLineAtLine(6);
    int key = 1;
    TraceHooks.putMapAtLine(6, "freq", freq, key, 1, "key");
    List<String> words = Arrays.asList("za", "x");
    for (String word : TraceHooks.iterationBindAtLine(7, "words", words, "word")) {
      if (word.length() == 0) throw new RuntimeException("unreachable");
    }
    List<List<Integer>> graph = new ArrayList<>();
    TraceHooks.emitLineAtLine(8);
    graph.add(new ArrayList<>());
    TraceHooks.emitMutatingCallAtLine(8, "graph", "add", graph.get(0));
    TraceHooks.emitRuntimeSnapshotAtLine(8, "graph", graph);
    graph.get(0).add(7);
    for (Integer next : TraceHooks.iterationBindAtLine(9, "graph", 0, graph.get(0), "next", "course")) {
      if (next == -1) throw new RuntimeException("unreachable");
    }

    Node node = new Node();
    TraceHooks.emitLineAtLine(12);
    TraceHooks.putFieldMapIfAbsentAtLine(12, "node", "children", node.children, 'a', new Node());
    TraceHooks.emitLineAtLine(13);
    node.isEnd = true;
    TraceHooks.emitFieldWriteAtLine(13, "node", "isEnd", node.isEnd);

    int[] matchRight = new int[] { 0, 0, 0 };
    TraceHooks.emitLineAtLine(14);
    TraceHooks.fillArrayAtLine(14, "matchRight", matchRight, -1);

    Deque<Integer> deque = new ArrayDeque<>();
    deque.addLast(1);
    TraceHooks.emitMutatingCallAtLine(15, "deque", "addLast", 1);
    TraceHooks.emitLineAtLine(16);
    deque.removeFirst();
    TraceHooks.emitMutatingCallAtLine(16, "deque", "removeFirst");
    TraceHooks.emitRuntimeSnapshotAtLine(16, "deque", deque);

    for (String event : TraceHooks.drainEvents()) System.out.println(event);
  }
}
`,
      'utf8'
    );
    execFileSync('mkdir', ['-p', classesPath]);
    execFileSync(
      'javac',
      ['-cp', join(process.cwd(), 'workers', 'vendor', 'java-browser-helper.jar'), '-d', classesPath, sourcePath],
      { cwd: process.cwd(), stdio: 'pipe' }
    );
    const output = execFileSync(
      'java',
      ['-cp', [classesPath, join(process.cwd(), 'workers', 'vendor', 'java-browser-helper.jar')].join(':'), 'Main'],
      { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' }
    );
    const trace = javaTraceHooksEventsToRuntimeTrace(output.trim().split('\n'), undefined, { runId: 'java:test' });
    assertCondition(
      trace.events.some((event) =>
        event.kind === 'snapshot' &&
        event.line === 6 &&
        'variable' in event.target &&
        event.target.variable === 'freq' &&
        JSON.stringify(event.value).includes('"1"')
      ),
      'Java Map mutation hooks should emit a post-mutation map snapshot on the same line'
    );
    assertCondition(
      trace.events.some((event) =>
        event.kind === 'write' &&
        event.line === 6 &&
        'variable' in event.target &&
        event.target.variable === 'freq' &&
        Array.isArray(event.target.path) &&
        event.target.path[0] === 1 &&
        JSON.stringify(event.target.indexSources) === JSON.stringify(['key'])
      ),
      'Java keyed mutation hooks should preserve simple index source provenance'
    );
    assertCondition(
      trace.events.some((event) =>
        event.kind === 'mutate' &&
        event.line === 6 &&
        'variable' in event.target &&
        event.target.variable === 'freq' &&
        Array.isArray(event.target.path) &&
        event.target.path[0] === 1 &&
        JSON.stringify(event.target.indexSources) === JSON.stringify(['key']) &&
        event.method === 'put' &&
        JSON.stringify(event.args) === JSON.stringify([1, 1])
      ),
      'Java keyed mutation hooks should emit key/value method args with index source provenance'
    );
    assertCondition(
      trace.events.some((event) =>
        event.kind === 'read' &&
        event.line === 7 &&
        'variable' in event.target &&
        event.target.variable === 'words' &&
        Array.isArray(event.target.path) &&
        event.target.path[0] === 0 &&
        event.binding?.kind === 'iteration' &&
        event.binding.variable === 'word' &&
        event.value === 'za'
      ),
      'Java iteration binding hooks should emit indexed read bindings for enhanced-for values'
    );
    assertCondition(
      trace.events.some((event) =>
        event.kind === 'mutate' &&
        event.line === 8 &&
        'variable' in event.target &&
        event.target.variable === 'graph' &&
        event.method === 'add' &&
        JSON.stringify(event.args) === JSON.stringify([[]])
      ),
      'Java collection mutation hooks should emit runtime-evaluated method args for plain collection adds'
    );
    assertCondition(
      trace.events.some((event) =>
        event.kind === 'read' &&
        event.line === 9 &&
        'variable' in event.target &&
        event.target.variable === 'graph' &&
        Array.isArray(event.target.path) &&
        event.target.path[0] === 0 &&
        event.target.path[1] === 0 &&
        JSON.stringify(event.target.indexSources) === JSON.stringify(['course', null]) &&
        event.binding?.kind === 'iteration' &&
        event.binding.variable === 'next' &&
        event.value === 7
      ),
      'Java nested iteration binding hooks should emit parent path provenance for enhanced-for values'
    );
    assertCondition(
      trace.events.some((event) =>
        event.kind === 'write' &&
        event.line === 12 &&
        'variable' in event.target &&
        event.target.variable === 'node' &&
        Array.isArray(event.target.path) &&
        event.target.path.length === 2 &&
        event.target.path[0] === 'children' &&
        event.target.path[1] === 'a'
      ),
      'Java object field map mutation hooks should emit a native field/key write without a synthetic field snapshot'
    );
    assertCondition(
      !trace.events.some((event) =>
        event.kind === 'snapshot' &&
        'variable' in event.target &&
        (event.target.variable === 'node.children' || event.target.variable === 'node.isEnd')
      ),
      'Java object field mutation hooks should not emit synthetic dotted field snapshots'
    );
    assertCondition(
      trace.events.some((event) =>
        event.kind === 'mutate' &&
        event.line === 14 &&
        'variable' in event.target &&
        event.target.variable === 'matchRight' &&
        event.method === 'fill' &&
        JSON.stringify(event.args) === JSON.stringify([-1])
      ),
      'Java Arrays.fill hook should emit a fill mutation with the runtime fill value'
    );
    assertCondition(
      trace.events.some((event) =>
        event.kind === 'snapshot' &&
        event.line === 14 &&
        'variable' in event.target &&
        event.target.variable === 'matchRight' &&
        JSON.stringify(event.value) === JSON.stringify([-1, -1, -1])
      ),
      'Java Arrays.fill hook should emit a post-fill array snapshot'
    );
    assertCondition(
      trace.events.some((event) =>
        event.kind === 'mutate' &&
        event.line === 16 &&
        'variable' in event.target &&
        event.target.variable === 'deque' &&
        event.method === 'removeFirst' &&
        JSON.stringify(event.args) === JSON.stringify([])
      ),
      'Java no-arg mutation helper overloads should emit an empty args array'
    );
    console.log('PASS: Java native mutation hooks emit post-line snapshots');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function testJavaArraySortHooksEmitIndexedWrites(): void {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'tracecode-java-sort-hook-'));
  try {
    const sourcePath = join(tmpRoot, 'Main.java');
    const classesPath = join(tmpRoot, 'classes');
    writeFileSync(
      sourcePath,
      `import tracecode.user.TraceHooks;

public class Main {
  public static void main(String[] args) {
    TraceHooks.reset();
    int[] nums = new int[] { 3, 1, 2 };
    TraceHooks.sortArrayAtLine(7, "nums", nums);
    for (String event : TraceHooks.drainEvents()) System.out.println(event);
  }
}
`,
      'utf8'
    );
    execFileSync('mkdir', ['-p', classesPath]);
    execFileSync(
      'javac',
      ['-cp', join(process.cwd(), 'workers', 'vendor', 'java-browser-helper.jar'), '-d', classesPath, sourcePath],
      { cwd: process.cwd(), stdio: 'pipe' }
    );
    const output = execFileSync(
      'java',
      ['-cp', [classesPath, join(process.cwd(), 'workers', 'vendor', 'java-browser-helper.jar')].join(':'), 'Main'],
      { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' }
    );
    const trace = javaTraceHooksEventsToRuntimeTrace(output.trim().split('\n'), undefined, {
      runId: 'java:test',
      file: 'solution.java',
    });
    assertCondition(
      trace.events.some((event) =>
        event.kind === 'mutate' &&
        'variable' in event.target &&
        event.target.variable === 'nums' &&
        event.method === 'sort'
      ) &&
        trace.events.some((event) =>
          event.kind === 'write' &&
          'variable' in event.target &&
          event.target.variable === 'nums' &&
          'path' in event.target &&
          JSON.stringify(event.target.path) === JSON.stringify([0]) &&
          event.value === 1
        ),
      `Java Arrays.sort hooks should emit receiver mutation plus concrete sorted-cell writes, received ${JSON.stringify(trace.events)}`
    );
    console.log('PASS: Java Arrays.sort hooks emit concrete indexed writes');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function testJavaListSortHooksEmitIndexedWrites(): void {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'tracecode-java-list-sort-hook-'));
  try {
    const sourcePath = join(tmpRoot, 'Main.java');
    const classesPath = join(tmpRoot, 'classes');
    writeFileSync(
      sourcePath,
      `import tracecode.user.TraceHooks;
import java.util.*;

public class Main {
  public static void main(String[] args) {
    TraceHooks.reset();
    List<Integer> nums = new ArrayList<>(Arrays.asList(3, 1, 2));
    TraceHooks.sortListAtLine(8, "nums", nums, null);
    for (String event : TraceHooks.drainEvents()) System.out.println(event);
  }
}
`,
      'utf8'
    );
    execFileSync('mkdir', ['-p', classesPath]);
    execFileSync(
      'javac',
      ['-cp', join(process.cwd(), 'workers', 'vendor', 'java-browser-helper.jar'), '-d', classesPath, sourcePath],
      { cwd: process.cwd(), stdio: 'pipe' }
    );
    const output = execFileSync(
      'java',
      ['-cp', [classesPath, join(process.cwd(), 'workers', 'vendor', 'java-browser-helper.jar')].join(':'), 'Main'],
      { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' }
    );
    const trace = javaTraceHooksEventsToRuntimeTrace(output.trim().split('\n'), undefined, {
      runId: 'java:test',
      file: 'solution.java',
    });
    assertCondition(
      trace.events.some((event) =>
        event.kind === 'mutate' &&
        'variable' in event.target &&
        event.target.variable === 'nums' &&
        event.method === 'sort'
      ) &&
        trace.events.some((event) =>
          event.kind === 'write' &&
          'variable' in event.target &&
          event.target.variable === 'nums' &&
          'path' in event.target &&
          JSON.stringify(event.target.path) === JSON.stringify([0]) &&
          event.value === 1
        ),
      `Java List.sort hooks should emit receiver mutation plus concrete sorted-cell writes, received ${JSON.stringify(trace.events)}`
    );
    console.log('PASS: Java List.sort hooks emit concrete indexed writes');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function testNativeJavaRewriterRegressionGaps(): void {
  const reflectiveTypeSource = rewriteWithNativeJavaRewriter(`import java.lang.reflect.*;

class Solution {
  Object solve() throws Exception {
    java.lang.reflect.Constructor<?> ctor = String.class.getDeclaredConstructor();
    return ctor.newInstance();
  }
}`);
  assertCondition(
    reflectiveTypeSource.includes('java.lang.reflect.Constructor<?> ctor = String.class.getDeclaredConstructor();'),
    'Java rewriter should not treat package-qualified type names as object field reads'
  );
  assertCondition(
    !reflectiveTypeSource.includes('TraceHooks.readObjectFieldAtLine(5, "java"'),
    'Java rewriter should not instrument java.lang.reflect as field access'
  );

  const literalSource = rewriteWithNativeJavaRewriter(`class Solution {
  int solve() {
    String key = "tracecode.caseIndex";
    return key.length();
  }
}`);
  assertCondition(
    literalSource.includes('String key = "tracecode.caseIndex";'),
    'Java rewriter should preserve string literals that contain dotted names'
  );
  assertCondition(
    !literalSource.includes('"TraceHooks.readObjectFieldAtLine'),
    'Java rewriter should not inject field-read hooks inside string literals'
  );

  const fluentSource = rewriteWithNativeJavaRewriter(`import java.util.*;
import java.util.stream.*;

class Solution {
  long solve(int[] nums) {
    return Arrays.stream(nums)
      .filter(n -> n > 0)
      .map(n -> n * 2)
      .count();
  }
}`);
  assertCondition(
    !fluentSource.includes('TraceHooks.emitLineAtLine(7);\n      .filter') &&
      !fluentSource.includes('TraceHooks.emitLineAtLine(8);\n      .map'),
    'Java rewriter should not insert standalone line hooks before fluent continuation lines'
  );

  const initializerSource = rewriteWithNativeJavaRewriter(`import java.util.*;

class Solution {
  int solve() {
    List<double[]> edges = new ArrayList<>();
    edges.add(new double[] {
      1.0,
      2.0
    });
    return edges.size();
  }
}`);
  assertCondition(
    initializerSource.includes('edges.add(new double[] {') &&
      initializerSource.includes('      1.0,') &&
      initializerSource.includes('      2.0'),
    'Java rewriter should preserve multiline array initializer calls'
  );
  assertCondition(
    !initializerSource.includes('TraceHooks.emitLineAtLine(7);\n      1.0') &&
      !initializerSource.includes('TraceHooks.emitLineAtLine(8);\n      2.0'),
    'Java rewriter should not insert line hooks inside multiline array initializers'
  );
  assertCondition(
    initializerSource.includes('\\"line\\":6') &&
      initializerSource.includes('\\"method\\":\\"add\\"') &&
      initializerSource.includes('\\"args\\":[') &&
      initializerSource.includes('TraceHooks.emitRuntimeSnapshotAtLine(6, "edges", edges);'),
    'Java rewriter should emit a mutate event with args for multiline collection adds on the call source line'
  );
  assertNativeJavaRewriterCompiles(`import java.util.*;

class Solution {
  int solve() {
    List<double[]> edges = new ArrayList<>();
    edges.add(new double[] {
      1.0,
      2.0
    });
    return edges.size();
  }
}`);

  const noArgMutationsSource = assertNativeJavaRewriterCompiles(`import java.util.*;

class Box {
  List<Integer> values = new ArrayList<>();
}

class Solution {
  int solve() {
    Deque<Integer> queue = new ArrayDeque<>();
    queue.addLast(1);
    queue.removeFirst();
    List<Box> boxes = new ArrayList<>();
    boxes.add(new Box());
    boxes.get(0).values.clear();
    Set<Integer>[] sets = new Set[] { new HashSet<>() };
    sets[0].clear();
    return queue.size() + boxes.size() + sets.length;
  }
}`);
  assertCondition(
    noArgMutationsSource.includes('TraceHooks.emitNoArgMutatingCallAtLine(11, "queue", "removeFirst")') ||
      (noArgMutationsSource.includes('\\"line\\":11') &&
        noArgMutationsSource.includes('\\"method\\":\\"removeFirst\\"') &&
        noArgMutationsSource.includes('\\"args\\":[]')),
    'Java rewriter should route no-arg queue.removeFirst mutations through an empty-args mutate path'
  );
  assertCondition(
    noArgMutationsSource.includes('\\"line\\":14') &&
      noArgMutationsSource.includes('\\"method\\":\\"clear\\"') &&
      noArgMutationsSource.includes('\\"args\\":[]') &&
      noArgMutationsSource.includes(',\\"values\\"]'),
    'Java rewriter should emit empty args for no-arg field-indexed collection mutations'
  );
  assertCondition(
    noArgMutationsSource.includes('\\"line\\":16') &&
      noArgMutationsSource.includes('\\"method\\":\\"clear\\"') &&
      noArgMutationsSource.includes('\\"args\\":[]'),
    'Java rewriter should emit empty args for no-arg array-indexed collection mutations'
  );

  const unbracedLoopSource = assertNativeJavaRewriterCompiles(`class Solution {
  int solve(char[][] board) {
    int count = 0;
    for (int i = 0; i < board.length; i++)
      for (int j = 0; j < board[0].length; j++)
        if (board[i][j] == 'X' && (i == 0 || board[i-1][j] != 'X') && (j == 0 || board[i][j-1] != 'X'))
          count++;
    return count;
  }
}`);
  assertCondition(
    !unbracedLoopSource.includes('for (int j = 0; j < board[0].length; j++)\n        TraceHooks.emitLineAtLine'),
    'Java rewriter should not make a line hook the body of an unbraced nested loop'
  );

  const enhancedForArraySource = assertNativeJavaRewriterCompiles(`class Solution {
  int solve(Object[][] accounts) {
    int total = 0;
    for (Object[] account : accounts) {
      Object owner = account[0];
      for (int i = 1; i < account.length; i++) {
        Object value = account[i];
        total += String.valueOf(owner).length() + String.valueOf(value).length();
      }
    }
    return total;
  }
}`);
  assertCondition(
    enhancedForArraySource.includes('for (Object[] account : TraceHooks.iterationBindAtLine(4, "accounts", accounts, "account")) {') &&
      enhancedForArraySource.includes('TraceHooks.readObjectArrayAtLine(5, "account", account, 0, null)') &&
      enhancedForArraySource.includes('TraceHooks.readObjectArrayAtLine(7, "account", account, i, "i")'),
    'Java rewriter should register enhanced-for array aliases before instrumenting indexed reads from them'
  );

  const enhancedForBindingSource = assertNativeJavaRewriterCompiles(`class Solution {
  int solve(Object[][] accounts) {
    int total = 0;
    for (Object[] account : accounts) {
      total += account.length;
    }
    return total;
  }
}`);
  assertCondition(
    enhancedForBindingSource.includes('for (Object[] account : TraceHooks.iterationBindAtLine(4, "accounts", accounts, "account")) {'),
    'Java native rewriter should wrap enhanced-for array bindings with iteration provenance before worker augmentation'
  );

  const objectLengthFieldSource = assertNativeJavaRewriterCompiles(`class Box {
  int length;
}

class Solution {
  int solve() {
    Box box = new Box();
    box.length = 4;
    return box.length;
  }
}`);
  assertCondition(
    objectLengthFieldSource.includes('TraceHooks.readObjectFieldAtLine(9, "box", "length", box.length)'),
    'Java rewriter should treat user object .length fields as field reads, not array length metadata'
  );

  const stringBuilderAppendSource = assertNativeJavaRewriterCompiles(`class Solution {
  String solve(char ch) {
    StringBuilder order = new StringBuilder();
    order.append(ch);
    return order.toString();
  }
}`);
  assertCondition(
    stringBuilderAppendSource.includes('TraceHooks.emitMutatingCallAtLine(4, "order", "append", ch);'),
    'Java rewriter should emit mutate events for StringBuilder.append calls'
  );

  const expressionIndexSource = assertNativeJavaRewriterCompiles(`class Solution {
  String solve(String[] words) {
    int i = 0;
    String w2 = words[i + 1];
    return w2;
  }
}`);
  assertCondition(
    expressionIndexSource.includes('TraceHooks.readObjectArrayAtLine(4, "words", words, i + 1, "i + 1")'),
    'Java rewriter should preserve single-variable arithmetic index provenance such as i + 1'
  );

  const expressionIndexWriteSource = assertNativeJavaRewriterCompiles(`class Solution {
  long solve(int[] nums) {
    long[] prefix = new long[nums.length + 1];
    for (int i = 0; i < nums.length; i++) {
      prefix[i + 1] = prefix[i] + nums[i];
    }
    return prefix[nums.length];
  }
}`);
  assertCondition(
    expressionIndexWriteSource.includes('TraceHooks.emitArrayWriteAtLine(5, "prefix", __tracecodeIndex5, (Object) prefix[__tracecodeIndex5], "i + 1")'),
    'Java rewriter should preserve arithmetic index provenance on array writes'
  );

  const charComputedIndexSource = assertNativeJavaRewriterCompiles(`class Solution {
  int solve(String p) {
    int[] counts = new int[26];
    int base = 'a';
    for (int i = 0; i < p.length(); i++) {
      counts[p.charAt(i) - base]++;
    }
    return counts[0];
  }
}`);
  assertCondition(
    charComputedIndexSource.includes('indexSources\\":[\\"p.charAt(i) - base\\"') &&
      charComputedIndexSource.includes('TraceHooks.emitArrayWriteAtLine(6, "counts", p.charAt(i) - base, (Object) counts[p.charAt(i) - base], "p.charAt(i) - base")'),
    'Java rewriter should preserve charAt-derived computed array index provenance'
  );

  const computedStringMapKeySource = assertNativeJavaRewriterCompiles(`import java.util.*;

class Solution {
  public int solve() {
    Map<String, Integer> rightIndex = new HashMap<>();
    int nr = 1;
    int nc = 0;
    rightIndex.put(nr + "," + nc, 42);
    Integer v = rightIndex.get(nr + "," + nc);
    return v == null ? -1 : v;
  }
}`);
  assertCondition(
    computedStringMapKeySource.includes('TraceHooks.readMapAtLine(9, "rightIndex", rightIndex, nr + "," + nc, "nr + \\",\\" + nc")'),
    'Java rewriter should preserve computed string-concat map key provenance'
  );

  const explicitNullReturnSource = assertNativeJavaRewriterCompiles(`class Solution {
  Object solve(boolean done) {
    if (done) return null;
    return "open";
  }
}`);
  assertCondition(
    explicitNullReturnSource.includes('TraceHooks.emitSerializedReturnAtLine(3, "solve", TraceHooks.serializeResult(__tracecodeReturnValue3));') &&
      explicitNullReturnSource.includes('Object __tracecodeReturnValue3 = null;'),
    'Java rewriter should preserve explicit null return values in V4 return events'
  );

  const stringMatrixCharAtSource = assertNativeJavaRewriterCompiles(`class Solution {
  int solve(String[] board) {
    int count = 0;
    for (int r = 0; r < board.length; r++) {
      for (int c = 0; c < board[r].length(); c++) {
        if (board[r].charAt(c) == '.') count++;
      }
    }
    return count;
  }
}`);
  assertCondition(
    stringMatrixCharAtSource.includes('TraceHooks.readStringMatrixCharAtLine(6, "board", board, r, c, "r", "c")'),
    'Java rewriter should instrument String[] row charAt reads as 2D indexed reads with row/col provenance'
  );

  const stringArrayLengthCallSource = assertNativeJavaRewriterCompiles(`class Solution {
  int solve(String[] board) {
    int cols = board[0].length();
    return cols;
  }
}`);
  assertCondition(
    stringArrayLengthCallSource.includes('TraceHooks.readIndexedStringLengthAtLine(3, "board", board, 0, null)'),
    'Java rewriter should instrument String[] element length() reads as indexed length reads'
  );

  const ternaryContinuationSource = assertNativeJavaRewriterCompiles(`import java.util.*;

class Solution {
  int solve(String s) {
    Stack<Integer> stack = new Stack<>();
    int num = 3;
    stack.push(9);
    stack.push((int) (stack.pop() / (double) num > 0
        ? Math.floor(stack.peek() == null ? 0 : (double) stack.pop() / num)
        : Math.ceil(stack.peek() == null ? 0 : (double) stack.pop() / num)));
    return stack.peek();
  }
}`);
  assertCondition(
    !ternaryContinuationSource.includes('TraceHooks.emitLineAtLine(9') &&
      !ternaryContinuationSource.includes('TraceHooks.emitLineAtLine(10'),
    'Java rewriter should not inject standalone line hooks into ternary expression continuations'
  );
  assertCondition(
    ternaryContinuationSource.includes('TraceHooks.popStackAtLine(8, "stack", stack)') &&
      ternaryContinuationSource.includes('TraceHooks.popStackAtLine(9, "stack", stack)') &&
      ternaryContinuationSource.includes('TraceHooks.popStackAtLine(10, "stack", stack)'),
    'Java rewriter should preserve Stack.pop expression mutations as value-returning V4 hooks'
  );

  const stackPopIndexReadSource = assertNativeJavaRewriterCompiles(`import java.util.*;

class Solution {
  int solve(int[] heights) {
    Deque<Integer> stack = new ArrayDeque<>();
    stack.push(0);
    int poppedHeight = heights[stack.pop()];
    return poppedHeight;
  }
}`);
  assertCondition(
    stackPopIndexReadSource.includes('TraceHooks.readIntArrayAtLine(7, "heights", heights, TraceHooks.popDequeAtLine(7, "stack", stack), "stack.pop()")'),
    'Java rewriter should emit a value-returning Deque.pop hook when pop is used as an array-read index'
  );

  const stackPeekConditionIndexReadSource = assertNativeJavaRewriterCompiles(`import java.util.*;

class Solution {
  int solve(int[] heights) {
    Deque<Integer> stack = new ArrayDeque<>();
    stack.push(0);
    int best = 0;
    for (int i = 1; i < heights.length; i++) {
      while (!stack.isEmpty() && heights[stack.peek()] > heights[i]) {
        best = Math.max(best, heights[stack.pop()]);
      }
      stack.push(i);
    }
    return best;
  }
}`);
  assertCondition(
    stackPeekConditionIndexReadSource.includes('TraceHooks.readIntArrayAtLine(9, "heights", heights, TraceHooks.readQueuePeekAtLine(9, "stack", stack), "stack.peek()")'),
    'Java rewriter should preserve outer array-read provenance when a Deque.peek call is used as the index'
  );

  const listGetConditionIndexReadSource = assertNativeJavaRewriterCompiles(`import java.util.*;

class Solution {
  int solve(int[] temperatures) {
    List<Integer> stack = new ArrayList<>();
    stack.add(0);
    int hotter = 0;
    for (int i = 1; i < temperatures.length; i++) {
      while (!stack.isEmpty() && temperatures[stack.get(stack.size() - 1)] < temperatures[i]) {
        hotter++;
        stack.remove(stack.size() - 1);
      }
      stack.add(i);
    }
    return hotter;
  }
}`);
  assertCondition(
    listGetConditionIndexReadSource.includes('TraceHooks.readIntArrayAtLine(9, "temperatures", temperatures, TraceHooks.readListAtLine(9, "stack", stack, stack.size() - 1, "stack.size() - 1"), "stack.size() - 1")') &&
      listGetConditionIndexReadSource.includes('TraceHooks.readIntArrayAtLine(9, "temperatures", temperatures, i, "i")'),
    'Java rewriter should emit both outer array reads when a List.get call is used as an array-read index'
  );

  const listRemoveByStringSource = assertNativeJavaRewriterCompiles(`import java.util.*;

class Solution {
  boolean solve() {
    List<String> values = new ArrayList<>(Arrays.asList("a", "b"));
    return values.remove("a");
  }
}`);
  assertCondition(
    !listRemoveByStringSource.includes('TraceHooks.popListAtLine(6, "values", values, "a")') &&
      listRemoveByStringSource.includes('return __tracecodeReturnValue6;'),
    'Java rewriter should not rewrite List.remove(Object) string values as indexed pops'
  );
  const augmentedListRemoveByStringSource = augmentRewrittenJavaForTest(`import java.util.*;

class Solution {
  boolean solve() {
    List<String> values = new ArrayList<>(Arrays.asList("a", "b"));
    return values.remove("a");
  }
}`, 'solve');
  assertCondition(
    !augmentedListRemoveByStringSource.includes('TraceHooks.popListAtLine(6, "values", values, "a")') &&
      augmentedListRemoveByStringSource.includes('values.remove("a")'),
    'Java source augmentation should preserve List.remove(Object) string values after native rewrite'
  );

  const listRemoveBoxedOutput = executeNativeJavaRewrittenExpression(`import java.util.*;

class Solution {
  int solve() {
    List<Integer> values = new ArrayList<>(Arrays.asList(0, 1, 2));
    Integer boxed = Integer.valueOf(1);
    boolean removed = values.remove(boxed);
    return removed ? values.get(1) : -1;
  }
}`, 'new Solution().solve()');
  assertCondition(
    listRemoveBoxedOutput === '2',
    `Java rewriter should preserve boxed List.remove(Object) semantics, received ${listRemoveBoxedOutput}`
  );
  const augmentedListRemoveBoxedDeclarationSource = augmentRewrittenJavaForTest(`import java.util.*;

class Solution {
  int solve() {
    List<Integer> values = new ArrayList<>(Arrays.asList(0, 1, 2));
    Integer boxed = Integer.valueOf(1);
    boolean removed = values.remove(boxed);
    return removed ? values.get(1) : -1;
  }
}`, 'solve');
  assertCondition(
    !augmentedListRemoveBoxedDeclarationSource.includes('TraceHooks.popListAtLine(6, "values", values, boxed)') &&
      augmentedListRemoveBoxedDeclarationSource.includes('values.remove(boxed); TraceHooks.emitMutatingCallAtLine'),
    'Java source augmentation should keep the generic mutation event for boxed List.remove(Object)'
  );

  const listRemoveByIndexSource = assertNativeJavaRewriterCompiles(`import java.util.*;

class Solution {
  int solve() {
    List<Integer> values = new ArrayList<>(Arrays.asList(0, 1, 2));
    int index = 1;
    values.remove(index);
    return values.get(1);
  }
}`);
  assertCondition(
    listRemoveByIndexSource.includes('TraceHooks.popListAtLine(7, "values", values, index)') &&
      !listRemoveByIndexSource.includes('values.remove(index); TraceHooks.emitMutatingCallAtLine'),
    'Java rewriter should keep tracing primitive int List.remove(index) as an indexed pop'
  );

  const mutatingIndexWriteSource = rewriteWithNativeJavaRewriter(`import java.util.*;

class Solution {
  int[] solve(int[] nums) {
    int[] result = new int[nums.length];
    Deque<Integer> stack = new ArrayDeque<>();
    stack.push(0);
    result[stack.pop()] = nums[0];
    return result;
  }
}`);
  assertCondition(
    mutatingIndexWriteSource.includes('int __tracecodeIndex8 = stack.pop();'),
    'Java rewriter should evaluate mutating array-write index expressions once'
  );
  assertCondition(
    !mutatingIndexWriteSource.includes('result[stack.pop()] =') &&
      !mutatingIndexWriteSource.includes('TraceHooks.emitArrayWriteAtLine(8, "result", stack.pop()'),
    'Java rewriter should not duplicate mutating index expressions in array write hooks'
  );
  assertCondition(
    mutatingIndexWriteSource.includes('TraceHooks.emitArrayWriteAtLine(') &&
      mutatingIndexWriteSource.includes('"result", __tracecodeIndex8, (Object) result[__tracecodeIndex8],'),
    'Java rewriter should force 1D array-write hooks away from the 2D overload'
  );

  const indexedSetMutationSource = rewriteWithNativeJavaRewriter(`import java.util.*;

class Solution {
  int solve() {
    List<Set<Integer>> groups = new ArrayList<>();
    groups.add(new HashSet<>());
    groups.get(0).add(1);
    return groups.get(0).size();
  }
}`);
  assertCondition(
    indexedSetMutationSource.includes('((java.util.Set)((java.util.List)groups).get(0))'),
    'Java rewriter should cast indexed List<Set<...>> mutation targets to Set, not List'
  );

  const cloneGraphWindowSource = assertNativeJavaRewriterCompiles(`import java.util.*;
class Solution {
  List<List<Integer>> solve(int[][] adjList) {
    List<List<Integer>> cloned = new ArrayList<>();
    cloned.add(new ArrayList<>());
    int node = 0;
    for (int neighbor : adjList[node]) {
      cloned.get(node).add(neighbor);
    }
    return cloned;
  }
}`);
  assertCondition(
    cloneGraphWindowSource.includes('for (int neighbor : TraceHooks.iterationBindAtLine(7, "adjList", node, TraceHooks.readObjectArrayAtLine(7, "adjList", adjList, node, "node"), "neighbor", "node"))') &&
      cloneGraphWindowSource.includes('"kind\\":\\"mutate\\",\\"line\\":8') &&
      cloneGraphWindowSource.includes('\\"method\\":\\"add\\",\\"args\\":[" + TraceHooks.serializeResult(neighbor) + "]}'),
    'Java rewriter should preserve clone-graph enhanced-for row reads and indexed cloned.add mutation args'
  );

  const courseScheduleSource = augmentRewrittenJavaForTest(`import java.util.*;

class Solution {
  boolean solve(int numCourses) {
    List<List<Integer>> graph = new ArrayList<>();
    for (int i = 0; i < numCourses; i++) {
      graph.add(new ArrayList<>());
    }
    Deque<Integer> queue = new ArrayDeque<>();
    queue.addLast(0);
    for (int next : graph.get(0)) {
      queue.addLast(next);
    }
    return queue.size() > 0;
  }
}`, 'solve');
  assertCondition(
    courseScheduleSource.includes('TraceHooks.addCollectionAtLine(7, "graph", graph, new ArrayList<>())'),
    'Java source augmentation should emit mutate args for plain adjacency-list initialization adds'
  );
  assertCondition(
    courseScheduleSource.includes('TraceHooks.emitMutatingCallAtLine(10, "queue", "addLast", 0)'),
    'Java source augmentation should preserve runtime args for queue addLast mutations'
  );
  const nativeWrappedDequeMutationSource = loadSourceAugmentationsForTest().augmentJavaCollectionOperations(`import java.util.*;

class Solution {
  boolean solve() {
    Deque<Integer> q = new ArrayDeque<>();
    int i = 5;
    { q.offerLast(i); TraceHooks.emitMutatingCallAtLine(6, "q", "offerLast", i); TraceHooks.emitIndexedWriteAtLine(6, "q", new Object[] { ((java.util.Collection) q).size() - 1 }, i, null); TraceHooks.emitRuntimeSnapshotAtLine(6, "q", q); }
    return true;
  }
}`, '');
  assertCondition(
    !nativeWrappedDequeMutationSource.includes('TraceHooks.offerDequeLastAtLine') &&
      nativeWrappedDequeMutationSource.includes('q.offerLast(i); TraceHooks.emitMutatingCallAtLine'),
    `Java source augmentation should not double-wrap native-instrumented deque mutations, received ${nativeWrappedDequeMutationSource}`
  );
  const queueRemoveSource = augmentRewrittenJavaForTest(`import java.util.*;

class Solution {
  boolean solve() {
    Queue<Integer> queue = new ArrayDeque<>();
    queue.offer(1);
    int node = queue.remove();
    return node == 1;
  }
}`, 'solve');
  assertCondition(
    queueRemoveSource.includes('TraceHooks.removeQueueAtLine(7, "queue", queue)') &&
      !queueRemoveSource.includes('queue, )'),
    'Java source augmentation should rewrite no-arg Queue.remove() through a value-returning V4 hook without emitting a trailing comma'
  );
  assertNativeJavaRewriterCompiles(`import java.util.*;

class Solution {
  boolean solve() {
    Queue<Integer> queue = new ArrayDeque<>();
    queue.offer(1);
    int node = queue.remove();
    return node == 1;
  }
}`, 'solve');
  assertCondition(
    courseScheduleSource.includes('TraceHooks.iterationBindAtLine(11, "graph", 0, TraceHooks.readObjectListAtLine(11, "graph", graph, 0, null), "next", null)') ||
      courseScheduleSource.includes('TraceHooks.iterationBindAtLine(11, "graph", 0, TraceHooks.readListAtLine(11, "graph", graph, 0, null), "next", null)'),
    'Java source augmentation should emit nested enhanced-for iteration binding over adjacency-list get(...) sources'
  );
  const nativeListGetEnhancedForSource = assertNativeJavaRewriterCompiles(`import java.util.*;

class Solution {
  boolean solve(int n) {
    List<List<Integer>> graph = new ArrayList<>();
    graph.add(new ArrayList<>());
    int node = 0;
    for (int next : graph.get(node)) {
      return next == 1;
    }
    return false;
  }
}`);
  assertCondition(
    nativeListGetEnhancedForSource.includes('for (int next : TraceHooks.iterationBindAtLine(8, "graph", node, TraceHooks.readListAtLine(8, "graph", graph, node, "node"), "next", "node"))'),
    'Java native rewriter should emit nested enhanced-for iteration binding over List.get(...) sources'
  );

  const arraysFillSource = augmentRewrittenJavaForTest(`import java.util.*;

class Solution {
  int solve(int n) {
    int[] matchRight = new int[n];
    Arrays.fill(matchRight, -1);
    return matchRight[0];
  }
}`, 'solve');
  assertCondition(
    arraysFillSource.includes('TraceHooks.fillArrayAtLine(6, "matchRight", matchRight, -1)'),
    'Java source augmentation should rewrite Arrays.fill(array, value) as an array fill mutation hook'
  );
  assertJavaSourceCompiles(arraysFillSource, 'augmented Java Arrays.fill source');

  const arraysSortSource = augmentRewrittenJavaForTest(`import java.util.*;

class Solution {
  int solve(int[][] intervals) {
    int[][] sorted = intervals.clone();
    Arrays.sort(sorted, (left, right) -> Integer.compare(left[0], right[0]));
    return sorted[0][0];
  }
}`, 'solve');
  assertCondition(
    arraysSortSource.includes('TraceHooks.sortArrayAtLine(6, "sorted", sorted, (left, right) -> Integer.compare(left[0], right[0]))'),
    'Java source augmentation should rewrite Arrays.sort(array, comparator) as an array sort mutation hook'
  );
  assertJavaSourceCompiles(arraysSortSource, 'augmented Java Arrays.sort source');

  const listSortSource = augmentRewrittenJavaForTest(`import java.util.*;

class Solution {
  List<Integer> solve(List<Integer> nums) {
    nums.sort((left, right) -> Integer.compare(left, right));
    Collections.sort(nums);
    return nums;
  }
}`, 'solve');
  assertCondition(
    listSortSource.includes('TraceHooks.sortListAtLine(5, "nums", nums, (left, right) -> Integer.compare(left, right))') &&
      listSortSource.includes('TraceHooks.sortListAtLine(6, "nums", nums, null)'),
    `Java source augmentation should rewrite List.sort and Collections.sort as list sort mutation hooks, received ${listSortSource}`
  );
  assertJavaSourceCompiles(listSortSource, 'augmented Java List.sort source');

  const charLiteralBraceSource = augmentRewrittenJavaForTest(`import java.util.*;

class Solution {
  public boolean isValid(String s) {
    Deque<Character> stack = new ArrayDeque<>();
    for (int i = 0; i < s.length(); i += 1) {
      char ch = s.charAt(i);
      if (ch == '(' || ch == '[' || ch == '{') {
        stack.push(ch);
      } else {
        if (stack.isEmpty()) {
          return false;
        }
        char open = stack.pop();
        if ((ch == ')' && open != '(') || (ch == ']' && open != '[') || (ch == '}' && open != '{')) {
          return false;
        }
      }
    }
    return stack.isEmpty();
  }
}`, 'isValid');
  const returnIndex = charLiteralBraceSource.indexOf('return stack.isEmpty();');
  const preReturnLines = charLiteralBraceSource.slice(0, returnIndex).split('\n');
  const lastLineSnapshotBeforeReturn = preReturnLines.findLast((line) => line.includes('TraceHooks.emitLineAtLine(')) ?? '';
  assertCondition(
    !lastLineSnapshotBeforeReturn.includes('TraceHooks.serializeResult(i)') &&
      !lastLineSnapshotBeforeReturn.includes('TraceHooks.serializeResult(ch)'),
    'Java local snapshot augmentation should ignore braces inside char literals when closing loop-local scopes'
  );

  console.log('PASS: native Java rewriter preserves TC83 regression gap shapes');
}

async function loadWorkerSource(): Promise<string> {
  const workerPath = join(process.cwd(), 'workers', 'java', 'java-worker.js');
  return readFile(workerPath, 'utf8');
}

async function loadJavaSourceAugmentationSource(): Promise<string> {
  const helperPath = join(process.cwd(), 'workers', 'java', 'java-source-augmentations.js');
  return readFile(helperPath, 'utf8');
}

function createWorkerHarness(workerSource: string, augmentationSource: string) {
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeoutId: ReturnType<typeof setTimeout>;
      protocolToken: string;
      events: unknown[];
    }
  >();
  const rewriteCalls: RewriteCall[] = [];
  const stringFiles: Array<{ path: string; source: string }> = [];
  const projectCompileCalls: Array<{
    sourcePaths: string;
    mainClassName: string;
    resourceManifest?: string;
    compileClasspath?: string;
    compileSourcePaths?: string;
    compileSourceRootPaths?: string;
    workspaceManifest?: string;
    workspaceRoot?: string;
    workspaceCwd?: string;
  }> = [];
  const projectClassCompileCalls: Array<{
    classManifest: string;
    mainClassName: string;
    runtimeClasspath: string;
    sourceManifest?: string;
    workspaceManifest?: string;
    workspaceRoot?: string;
    workspaceCwd?: string;
  }> = [];
  const runLibraryClasspaths: string[] = [];
  const httpDispatches: Array<{ request: Record<string, unknown>; timeoutMs?: number }> = [];
  let cheerpjInitOptions: { natives?: Record<string, (...args: unknown[]) => unknown> } | undefined;
  let nextId = 0;

  const selfObject: {
    postMessage: (message: WorkerMessage) => void;
    onmessage: ((event: { data: WorkerMessage }) => void) | null;
    importScripts: (...urls: string[]) => void;
    cheerpjInit: (options?: { natives?: Record<string, (...args: unknown[]) => unknown> }) => Promise<void>;
    cheerpOSAddStringFile: (path: string, source: string) => Promise<void>;
    cheerpjRunLibrary: (classpath?: string) => Promise<unknown>;
    close: () => void;
  } = {
    postMessage: (message: WorkerMessage) => {
      if (message.type === 'worker-ready') {
        return;
      }
      const id = message.id;
      if (!id) return;
      const entry = pending.get(id);
      if (!entry) return;
      if (message.protocolToken !== entry.protocolToken) return;
      if (message.type === 'project-event') {
        entry.events.push(message.payload);
        return;
      }
      if (message.type === 'kernel-http-dispatch-sync') {
        const payload = message.payload as {
          request?: Record<string, unknown>;
          buffer?: SharedArrayBuffer;
          timeoutMs?: number;
        } | undefined;
        httpDispatches.push({
          request: payload?.request ?? {},
          ...(payload?.timeoutMs !== undefined ? { timeoutMs: payload.timeoutMs } : {}),
        });
        if (isJavaHttpTestSharedArrayBuffer(payload?.buffer)) {
          writeJavaHttpTestManifest(payload.buffer, javaHttpOkTestManifest(209, 'java-http-ok\n'));
        }
        return;
      }
      pending.delete(id);
      clearTimeout(entry.timeoutId);
      if (message.type === 'error') {
        const payload = message.payload as { error?: unknown } | undefined;
        entry.reject(new Error(String(payload?.error ?? 'Worker error')));
        return;
      }
      entry.resolve(
        entry.events.length > 0
          ? { ...(message.payload as Record<string, unknown>), events: entry.events }
          : message.payload
      );
    },
    onmessage: null,
    importScripts: (...urls: string[]) => {
      for (const url of urls) {
        if (String(url).endsWith('java-source-augmentations.js')) {
          vm.runInContext(augmentationSource, context, {
            filename: 'java-source-augmentations.js',
          });
        }
      }
    },
    cheerpjInit: async (options) => {
      cheerpjInitOptions = options;
    },
    cheerpOSAddStringFile: async (path: string, source: string) => {
      stringFiles.push({ path, source });
    },
    cheerpjRunLibrary: async (classpath?: string) => {
      runLibraryClasspaths.push(String(classpath ?? ''));
      return {
      tracecode: {
        browser: {
          BrowserCompileAndTraceLibrary: {
            compileAndTrace: async (_sourcePath: string, _classesDir: string, mainClassName: string) => {
              if (mainClassName.includes('warmup')) {
                return JSON.stringify({ success: true, output: '0', events: [] });
              }
              const latestSource = stringFiles.at(-1)?.source ?? '';
              if (latestSource.includes('uniquePaths') && latestSource.includes('__tracecodeScript')) {
                return JSON.stringify({
                  success: true,
                  output: JSON.stringify(10),
                  events: [
                    nativeJavaEvent({ kind: 'call', line: 15, function: '__tracecodeScript' }),
                    nativeJavaEvent({ kind: 'line', line: 16, function: '__tracecodeScript' }),
                    nativeJavaEvent({ kind: 'call', line: 4, function: 'uniquePaths', args: { rows: 3, cols: 4 } }),
                    nativeJavaEvent({ kind: 'line', line: 5, function: 'uniquePaths' }),
                    nativeJavaEvent({ kind: 'line', line: 8, function: 'uniquePaths' }),
                    nativeJavaEvent({ kind: 'line', line: 9, function: 'uniquePaths' }),
                    nativeJavaEvent({ kind: 'line', line: 10, function: 'uniquePaths' }),
                    nativeJavaEvent({ kind: 'write', line: 10, function: 'uniquePaths', target: { variable: 'dp', path: [1, 1] }, value: 2 }),
                    nativeJavaEvent({ kind: 'snapshot', line: 10, function: 'uniquePaths', target: { variable: 'dp' }, value: [[1, 1, 1, 1], [1, 2, 0, 0], [1, 0, 0, 0]] }),
                    nativeJavaEvent({ kind: 'line', line: 10, function: 'uniquePaths' }),
                    nativeJavaEvent({ kind: 'write', line: 10, function: 'uniquePaths', target: { variable: 'dp', path: [1, 2] }, value: 3 }),
                    nativeJavaEvent({ kind: 'snapshot', line: 10, function: 'uniquePaths', target: { variable: 'dp' }, value: [[1, 1, 1, 1], [1, 2, 3, 0], [1, 0, 0, 0]] }),
                    nativeJavaEvent({ kind: 'line', line: 9, function: 'uniquePaths' }),
                    nativeJavaEvent({ kind: 'line', line: 10, function: 'uniquePaths' }),
                    nativeJavaEvent({ kind: 'write', line: 10, function: 'uniquePaths', target: { variable: 'dp', path: [2, 1] }, value: 3 }),
                    nativeJavaEvent({ kind: 'snapshot', line: 10, function: 'uniquePaths', target: { variable: 'dp' }, value: [[1, 1, 1, 1], [1, 2, 3, 4], [1, 3, 0, 0]] }),
                    nativeJavaEvent({ kind: 'return', line: 13, function: 'uniquePaths' }),
                    nativeJavaEvent({ kind: 'line', line: 17, function: '__tracecodeScript' }),
                    nativeJavaEvent({ kind: 'return', line: 17, function: '__tracecodeScript' }),
                  ],
                });
              }
              if (latestSource.includes('class TreeNode') && latestSource.includes('class ListNode') && latestSource.includes('class UnionFind')) {
                return JSON.stringify({
                  success: true,
                  output: JSON.stringify([3, 2, 2]),
                  events: [
                    nativeJavaEvent({ kind: 'call', line: 42, function: '__tracecodeScript' }),
                    nativeJavaEvent({ kind: 'return', line: 50, function: '__tracecodeScript' }),
                  ],
                });
              }
              if (latestSource.includes('buildGraph')) {
                return JSON.stringify({
                  success: true,
                  output: JSON.stringify([0, 1, 2]),
                  events: [
                    nativeJavaEvent({ kind: 'call', line: 4, function: 'buildGraph', args: { n: 3 } }),
                    nativeJavaEvent({ kind: 'snapshot', line: 5, target: { variable: 'graph' }, value: [[], [], []] }),
                    nativeJavaEvent({ kind: 'read', line: 6, target: { variable: 'graph', path: [0] }, value: [] }),
                    nativeJavaEvent({ kind: 'mutate', line: 6, target: { variable: 'graph', path: [0] }, method: 'add' }),
                    nativeJavaEvent({ kind: 'snapshot', line: 6, target: { variable: 'graph' }, value: [[1], [], []] }),
                    nativeJavaEvent({ kind: 'read', line: 7, target: { variable: 'graph', path: [1] }, value: [] }),
                    nativeJavaEvent({ kind: 'mutate', line: 7, target: { variable: 'graph', path: [1] }, method: 'add' }),
                    nativeJavaEvent({ kind: 'snapshot', line: 7, target: { variable: 'graph' }, value: [[1], [2], []] }),
                    nativeJavaEvent({ kind: 'read', line: 10, target: { variable: 'graph', path: [0] }, value: [1] }),
                    nativeJavaEvent({ kind: 'line', line: 10, function: 'buildGraph' }),
                    nativeJavaEvent({ kind: 'read', line: 11, target: { variable: 'graph', path: [1] }, value: [2] }),
                    nativeJavaEvent({ kind: 'line', line: 11, function: 'buildGraph' }),
                    nativeJavaEvent({ kind: 'return', line: 13, function: 'buildGraph', value: [0, 1, 2] }),
                  ],
                });
              }
              if (latestSource.includes('values.add(n); TraceHooks.emit("trace:{\\"kind\\":\\"mutate\\"')) {
                return JSON.stringify({
                  success: true,
                  output: JSON.stringify(1),
                  events: [
                    nativeJavaEvent({ kind: 'call', line: 6, function: 'solve', args: { n: 4 } }),
                    nativeJavaEvent({ kind: 'line', line: 7, function: 'solve' }),
                    nativeJavaEvent({ kind: 'line', line: 8, function: 'solve' }),
                    nativeJavaEvent({ kind: 'mutate', line: 8, function: 'solve', target: { variable: 'this', path: ['values'] }, method: 'add' }),
                    nativeJavaEvent({ kind: 'return', line: 9, function: 'solve', value: 1 }),
                  ],
                });
              }
              if (latestSource.includes('totalAccounts') && latestSource.includes('TraceHooks.iterationBindAtLine')) {
                return JSON.stringify({
                  success: true,
                  output: JSON.stringify(5),
                  events: [
                    nativeJavaEvent({ kind: 'call', line: 2, function: 'totalAccounts', args: { accounts: [['John', 'a@mail'], ['Ada', 'b@mail', 'c@mail']] } }),
                    nativeJavaEvent({
                      kind: 'read',
                      line: 4,
                      target: { variable: 'accounts', path: [0] },
                      value: ['John', 'a@mail'],
                      binding: { kind: 'iteration', variable: 'account' },
                    }),
                    nativeJavaEvent({ kind: 'write', line: 4, target: { variable: 'account' }, value: ['John', 'a@mail'] }),
                    nativeJavaEvent({ kind: 'return', line: 7, function: 'totalAccounts', value: 5 }),
                  ],
                });
              }
              if (latestSource.includes('putMapIfAbsentAtLine') && latestSource.includes('inDegree')) {
                return JSON.stringify({
                  success: true,
                  output: JSON.stringify(2),
                  events: [
                    nativeJavaEvent({ kind: 'call', line: 4, function: 'order', args: { letters: ['z', 'a', 'z'] } }),
                    nativeJavaEvent({
                      kind: 'mutate',
                      line: 7,
                      target: { variable: 'inDegree', path: ['z'], indexSources: ['ch'] },
                      method: 'putIfAbsent',
                      args: ['z', 0],
                    }),
                    nativeJavaEvent({ kind: 'return', line: 9, function: 'order', value: 2 }),
                  ],
                });
              }
              if (
                (latestSource.includes('putFieldMapIfAbsentAtLine') && latestSource.includes('children')) ||
                (latestSource.includes('class TrieNode') && latestSource.includes('children.putIfAbsent'))
              ) {
                return JSON.stringify({
                  success: true,
                  output: JSON.stringify(2),
                  events: [
                    nativeJavaEvent({ kind: 'call', line: 8, function: 'insert', args: { word: 'app' } }),
                    nativeJavaEvent({
                      kind: 'mutate',
                      line: 10,
                      target: { variable: 'node', path: ['children', 'a'], indexSources: [null, 'ch'] },
                      method: 'putIfAbsent',
                      args: ['a', 'tracecode.user.TrieNode@1'],
                    }),
                    nativeJavaEvent({ kind: 'return', line: 12, function: 'insert', value: 2 }),
                  ],
                });
              }
              return JSON.stringify({
                success: true,
                output: JSON.stringify([0, 1]),
                events: [
                  nativeJavaEvent({ kind: 'call', line: 1, function: '__tracecodeScript' }),
                  nativeJavaEvent({ kind: 'snapshot', line: 2, function: '__tracecodeScript', target: { variable: 'seen' }, value: {} }),
                  nativeJavaEvent({ kind: 'return', line: 99, function: '__tracecodeScript' }),
                ],
              });
            },
            compileAndRun: async (
              _sourcePath: string,
              _classesDir: string,
              mainClassName: string,
              _compileClasspath: string,
              compilerProfile: string
            ) => {
              if (mainClassName.includes('warmup')) {
                return JSON.stringify({
                  success: true,
                  output: JSON.stringify(3),
                  compilerStdout: '',
                  compilerStderr: '',
                  compileTimeMs: 0,
                  classLoadTimeMs: 0,
                  runTimeMs: 0,
                  compileCacheHit: true,
                  compilerDebugProfile: compilerProfile,
                });
              }
              return JSON.stringify({
                success: true,
                output: JSON.stringify([0, 1]),
                compilerStdout: '',
                compilerStderr: '',
                compileTimeMs: 1,
                classLoadTimeMs: 1,
                runTimeMs: 1,
                compileCacheHit: true,
                compilerDebugProfile: compilerProfile,
              });
            },
            compileAndRunProjectSources: async (
              sourceManifest: string,
              _sourceRoot: string,
              _classesDir: string,
              mainClassName: string,
              compileClasspath: string,
              compilerProfile: string
            ) => {
              projectCompileCalls.push({ sourcePaths: sourceManifest, mainClassName, compileClasspath });
              return JSON.stringify({
                success: true,
                output: JSON.stringify(JSON.stringify({
                  stdout: '5\njava_args=alpha,beta\n',
                  stderr: '',
                  exitCode: 0,
                })),
                compilerStdout: '',
                compilerStderr: '',
                compileTimeMs: 1,
                classLoadTimeMs: 1,
                runTimeMs: 1,
                compileCacheHit: true,
                compilerDebugProfile: compilerProfile,
              });
            },
            compileAndRunProjectSourcesWithResources: async (
              sourceManifest: string,
              _sourceRoot: string,
              resourceManifest: string,
              _resourceRoot: string,
              _classesDir: string,
              mainClassName: string,
              compileClasspath: string,
              compilerProfile: string
            ) => {
              projectCompileCalls.push({ sourcePaths: sourceManifest, mainClassName, resourceManifest, compileClasspath });
              return JSON.stringify({
                success: true,
                output: JSON.stringify(JSON.stringify({
                  stdout: '5\njava_args=alpha,beta\n',
                  stderr: '',
                  exitCode: 0,
                })),
                compilerStdout: '',
                compilerStderr: '',
                compileTimeMs: 1,
                classLoadTimeMs: 1,
                runTimeMs: 1,
                compileCacheHit: true,
                compilerDebugProfile: compilerProfile,
              });
            },
            compileAndRunProjectSourcesWithWorkspace: async (
              sourceManifest: string,
              _sourceRoot: string,
              resourceManifest: string,
              _resourceRoot: string,
              workspaceManifest: string,
              workspaceRoot: string,
              workspaceCwd: string,
              _classesDir: string,
              mainClassName: string,
              compileClasspath: string,
              compilerProfile: string
            ) => {
              projectCompileCalls.push({ sourcePaths: sourceManifest, mainClassName, resourceManifest, compileClasspath, workspaceManifest, workspaceRoot, workspaceCwd });
              const hasKernelProc = workspaceManifest.includes('/proc/kernel/info\t');
              const decodedSourceManifest = sourceManifest
                .split('\n')
                .filter(Boolean)
                .map((entry) => Buffer.from(entry.split('\t')[1] ?? '', 'base64').toString('utf8'))
                .join('\n');
              const hasKernelDevices = decodedSourceManifest.includes('ProjectEvents.setKernelDevices("') &&
                decodedSourceManifest.includes('/dev/stdout');
              const hasKernelFiles = decodedSourceManifest.includes('ProjectEvents.setKernelFiles("') &&
                workspaceManifest.includes('/tracekernel/custom\t');
              const hasCustomKernelDevices = hasKernelDevices &&
                decodedSourceManifest.includes('/dev/log') &&
                decodedSourceManifest.includes('/dev/custom-in');
              if (decodedSourceManifest.includes('TRACEKERNEL_HTTP_TIMEOUT_BRIDGE_PROBE')) {
                const dispatcher = cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_dispatchHttpNative;
                const manifest = dispatcher?.(null, JSON.stringify({
                  method: 'GET',
                  url: 'http://localhost:8771/java-timeout',
                  path: '/java-timeout',
                  headers: {},
                  _tracekernelTimeoutMs: 4567,
                }));
                return JSON.stringify({
                  success: true,
                  output: JSON.stringify(JSON.stringify({
                    stdout: String(manifest).startsWith('OK\n209\n') ? 'java-http-ok\n' : 'java-http-missing\n',
                    stderr: '',
                    exitCode: 0,
                  })),
                  compilerStdout: '',
                  compilerStderr: '',
                  compileTimeMs: 1,
                  classLoadTimeMs: 1,
                  runTimeMs: 1,
                  compileCacheHit: true,
                  compilerDebugProfile: compilerProfile,
                });
              }
              if (decodedSourceManifest.includes('boom-java-stack')) {
                const rawStderr = [
                  'Exception in thread "main" java.lang.RuntimeException: boom-java-stack',
                  '\tat Main.inner(Unknown Source)',
                  '\tat Main.main(Unknown Source)',
                  '\tat java.lang.reflect.Method.invoke(Unknown Source)',
                  '\tat tracecode.browser.BrowserCompileAndTraceLibrary.runEntryClass(Unknown Source)',
                  '\tat tracecode.browser.BrowserCompileAndTraceLibrary.compileAndRunProjectSourcesWithWorkspace(Unknown Source)',
                  '\tat com.leaningtech.cheerpj.CheerpJLibrary.run(Unknown Source)',
                  '',
                ].join('\n');
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stderr',
                  rawStderr
                );
                return JSON.stringify({
                  success: true,
                  output: JSON.stringify(JSON.stringify({
                    stdout: '',
                    stderr: rawStderr,
                    exitCode: 1,
                  })),
                  compilerStdout: '',
                  compilerStderr: '',
                  compileTimeMs: 1,
                  classLoadTimeMs: 1,
                  runTimeMs: 1,
                  compileCacheHit: true,
                  compilerDebugProfile: compilerProfile,
                });
              }
              const stdout = `after-nio-writer-live\nafter-empty-nio-stream\nafter-empty-nio-writer\nafter-empty-nio-channel\nafter-empty-open-writer\nafter-empty-open-stream\nafter-filewriter-live\n5\njava_args=alpha,beta\njava_stdin=from-stdin\n${hasKernelProc ? 'proc-info\nproc-stream=tracekernel test\nproc-random=tracekernel test\nproc-write:IOException\nproc-list=info,version\nproc-stat=true:false:28\n' : ''}${hasKernelFiles ? 'custom-kernel=custom-kernel-file\ncustom-kernel-random=custom-kernel-file\ncustom-kernel-write:IOException\ncustom-kernel-mkdir:IOException\ncustom-kernel-file-api=true:true:true:false\n' : ''}${hasKernelDevices ? hasCustomKernelDevices ? 'dev-list=capture,custom-in,log,null,stderr,stdin,stdout,tee,tty\ndev-stream=capture,custom-in,log,null,stderr,stdin,stdout,tee,tty\ndev-glob=stderr,stdin,stdout\ndev-filter=stderr,stdout\ndev-stat=true:true:true:false\ndev-nio-stat=true:false:false:true:0\ndev-custom=from-stdin:true\ndev-null=0\ndev-delete:IOException\ndev_stdin=from-stdin\ndev_stream_stdin=from-stdin\ndev_reader_stdin=from-stdin\ndev_nio_stream_stdin=from-stdin\ndev_nio_reader_stdin=from-stdin\ndev_read_all_lines=from-stdin\ndev_lines=from-stdin\ndev_channel_stdin=from-stdin\ndev_random_stdin=from-stdin\ndev_stream_custom=from-stdin\ndev_reader_custom=from-stdin\ndev_stdout\nfos_stdout\nfd_stdout\nfd_writer_stdout\nfd_stdin=from-stdin\ndev_writer\npw_stdout\nfw_tty\ndev_tty\ncapture-devicestdout-after-capture\ntee-devicestdout-after-tee\nfrom-stdin\nstdout-read:IOException\nstdout-stream-read:IOException\nstdout-reader-read:IOException\nstdout-nio-stream-read:IOException\n' : 'dev-list=null,stderr,stdin,stdout,tty\ndev-stream=null,stderr,stdin,stdout,tty\ndev-glob=stderr,stdin,stdout\ndev-filter=stderr,stdout\ndev-stat=true:true:true:false\ndev-nio-stat=true:false:false:true:0\ndev-null=0\ndev-delete:IOException\ndev_stdin=from-stdin\ndev_stream_stdin=from-stdin\ndev_reader_stdin=from-stdin\ndev_nio_stream_stdin=from-stdin\ndev_nio_reader_stdin=from-stdin\ndev_read_all_lines=from-stdin\ndev_lines=from-stdin\ndev_channel_stdin=from-stdin\ndev_random_stdin=from-stdin\ndev_stdout\nfos_stdout\nfd_stdout\nfd_writer_stdout\nfd_stdin=from-stdin\ndev_writer\npw_stdout\nfw_tty\ndev_tty\nfrom-stdin\nstdout-read:IOException\nstdout-stream-read:IOException\nstdout-reader-read:IOException\nstdout-nio-stream-read:IOException\n' : ''}`;
              const stderr = hasKernelDevices ? hasCustomKernelDevices ? 'dev_log\npw_log\ndev_stderr\nfd_stderr\nps_stderr\n' : 'dev_stderr\nfd_stderr\nps_stderr\n' : '';
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitFileSnapshotNative?.(
                null,
                'nio-writer-before-output.txt',
                Buffer.from('nio-before-output\n', 'utf8').toString('base64')
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                null,
                'stdout',
                'after-nio-writer-live\n'
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitFileSnapshotNative?.(
                null,
                'empty-nio-stream.bin',
                ''
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                null,
                'stdout',
                'after-empty-nio-stream\n'
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitFileSnapshotNative?.(
                null,
                'empty-nio-writer.txt',
                ''
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                null,
                'stdout',
                'after-empty-nio-writer\n'
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitFileSnapshotNative?.(
                null,
                'empty-nio-channel.bin',
                ''
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                null,
                'stdout',
                'after-empty-nio-channel\n'
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitFileSnapshotNative?.(
                null,
                'empty-open-writer.txt',
                ''
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                null,
                'stdout',
                'after-empty-open-writer\n'
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitFileSnapshotNative?.(
                null,
                'empty-open-stream.bin',
                ''
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                null,
                'stdout',
                'after-empty-open-stream\n'
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitFileSnapshotNative?.(
                null,
                'writer-before-output.txt',
                Buffer.from('before-output\n', 'utf8').toString('base64')
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                null,
                'stdout',
                'after-filewriter-live\n'
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                null,
                'stdout',
                '5\n'
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                null,
                'stdout',
                'java_args=alpha,beta\n'
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                null,
                'stdout',
                'java_stdin=from-stdin\n'
              );
              if (hasKernelProc) {
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  'proc-info\n'
                );
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  'proc-stream=tracekernel test\n'
                );
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  'proc-write:IOException\n'
                );
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  'proc-list=info,version\n'
                );
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  'proc-stat=true:false:28\n'
                );
              }
              if (hasKernelDevices) {
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  hasCustomKernelDevices ? 'dev-list=custom-in,log,null,stderr,stdin,stdout,tty\n' : 'dev-list=null,stderr,stdin,stdout,tty\n'
                );
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  hasCustomKernelDevices ? 'dev-stream=custom-in,log,null,stderr,stdin,stdout,tty\n' : 'dev-stream=null,stderr,stdin,stdout,tty\n'
                );
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  'dev-glob=stderr,stdin,stdout\n'
                );
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  'dev-filter=stderr,stdout\n'
                );
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  'dev-stat=true:true:true:false\n'
                );
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  'dev-nio-stat=true:false:false:true:0\n'
                );
                if (hasCustomKernelDevices) {
                  cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                    null,
                    'stdout',
                    'dev-custom=from-stdin:true\n'
                  );
                }
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  'dev-delete:IOException\n'
                );
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  'dev_stdin=from-stdin\n'
                );
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  'dev_stream_stdin=from-stdin\n'
                );
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  'dev_reader_stdin=from-stdin\n'
                );
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  'dev_nio_stream_stdin=from-stdin\n'
                );
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  'dev_nio_reader_stdin=from-stdin\n'
                );
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  'dev_read_all_lines=from-stdin\n'
                );
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  'dev_lines=from-stdin\n'
                );
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  'dev_channel_stdin=from-stdin\n'
                );
                if (hasCustomKernelDevices) {
                  cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                    null,
                    'stdout',
                    'dev_stream_custom=from-stdin\n'
                  );
                  cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                    null,
                    'stdout',
                    'dev_reader_custom=from-stdin\n'
                  );
                }
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  'dev_stdout\n'
                );
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  'fos_stdout\n'
                );
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  'fd_stdout\n',
                  '/dev/stdout'
                );
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  'fd_writer_stdout\n',
                  '/dev/stdout'
                );
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  'fd_stdin=from-stdin\n'
                );
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  'fd_reader_stdin=from-stdin\n'
                );
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  'dev_writer\n',
                  '/dev/stdout'
                );
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  'pw_stdout\n',
                  '/dev/stdout'
                );
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  'fw_tty\n',
                  '/dev/tty'
                );
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  'dev_tty\n',
                  '/dev/tty'
                );
                if (hasCustomKernelDevices) {
                  cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                    null,
                    'stdout',
                    'capture-device',
                    '',
                    '/dev/capture'
                  );
                  cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                    null,
                    'stdout',
                    'stdout-after-capture\n',
                    '',
                    '/dev/stdout'
                  );
                  cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                    null,
                    'stdout',
                    'tee-device',
                    '/dev/tee',
                    '/dev/capture'
                  );
                  cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                    null,
                    'stdout',
                    'stdout-after-tee\n',
                    '',
                    '/dev/stdout'
                  );
                }
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  'from-stdin\n'
                );
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  'bad_nested_device\n',
                  '/dev/nested/path'
                );
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  'stdout-read:IOException\n'
                );
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  'stdout-stream-read:IOException\n'
                );
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  'stdout-reader-read:IOException\n'
                );
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  'stdout-nio-stream-read:IOException\n'
                );
                if (hasCustomKernelDevices) {
                  cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                    null,
                    'stderr',
                    'dev_log\n',
                    '/dev/log'
                  );
                  cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                    null,
                    'stderr',
                    'pw_log\n',
                    '/dev/log'
                  );
                }
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stderr',
                  'dev_stderr\n'
                );
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stderr',
                  'fd_stderr\n',
                  '/dev/stderr'
                );
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stderr',
                  'ps_stderr\n'
                );
              }
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitFileSnapshotNative?.(
                null,
                'generated.txt',
                Buffer.from('created\n', 'utf8').toString('base64')
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitFileSnapshotNative?.(
                null,
                'writer.txt',
                Buffer.from('writer\n', 'utf8').toString('base64')
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitFileSnapshotNative?.(
                null,
                'printed.txt',
                Buffer.from('printed\n', 'utf8').toString('base64')
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitFileSnapshotNative?.(
                null,
                'ps-file.txt',
                Buffer.from('ps-file\n', 'utf8').toString('base64')
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitFileSnapshotNative?.(
                null,
                'stream.bin',
                Buffer.from([0, 254]).toString('base64')
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitFileSnapshotNative?.(
                null,
                'data.bin',
                Buffer.from([0, 253]).toString('base64')
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitFileSnapshotNative?.(
                null,
                'nio-created.txt',
                ''
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitFileSnapshotNative?.(
                null,
                'nio-created.txt',
                ''
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitFileSnapshotNative?.(
                null,
                'nio-created.txt',
                ''
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitDirectoryCreateNative?.(
                null,
                'live-dir'
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitDirectoryCreateNative?.(
                null,
                'live-dir/child'
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitDirectoryDeleteNative?.(
                null,
                'live-dir/child'
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitDirectoryCreateNative?.(
                null,
                'live-dir/renamed-child'
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitDirectoryDeleteNative?.(
                null,
                'live-dir/renamed-child'
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitDirectoryDeleteNative?.(
                null,
                'live-dir'
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitFileSnapshotNative?.(
                null,
                'nio-stream.bin',
                Buffer.from([0, 252]).toString('base64')
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitFileSnapshotNative?.(
                null,
                'nio-writer.txt',
                Buffer.from('nio-writer\n', 'utf8').toString('base64')
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitFileSnapshotNative?.(
                null,
                'byte-channel.bin',
                Buffer.from([0, 7, 6]).toString('base64')
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitFileSnapshotNative?.(
                null,
                'random.bin',
                Buffer.from([0, 9, 8]).toString('base64')
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitFileSnapshotNative?.(
                null,
                'classic-created.txt',
                ''
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitFileSnapshotNative?.(
                null,
                'classic-metadata.txt',
                ''
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitFileSnapshotNative?.(
                null,
                'classic-metadata.txt',
                ''
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitFileSnapshotNative?.(
                null,
                'classic-metadata.txt',
                ''
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitDirectoryCreateNative?.(
                null,
                'classic-dir'
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitDirectoryCreateNative?.(
                null,
                'classic-dir/child'
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitDirectoryDeleteNative?.(
                null,
                'classic-dir/child'
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitDirectoryCreateNative?.(
                null,
                'classic-dir/renamed-child'
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitDirectoryDeleteNative?.(
                null,
                'classic-dir/renamed-child'
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitDirectoryDeleteNative?.(
                null,
                'classic-dir'
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitFileDeleteNative?.(
                null,
                'classic-rename-source.txt'
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitFileSnapshotNative?.(
                null,
                'classic-renamed.txt',
                Buffer.from('classic\n', 'utf8').toString('base64')
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitFileDeleteNative?.(
                null,
                'classic-delete.txt'
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitFileSnapshotNative?.(
                null,
                'stdin-copy.txt',
                Buffer.from('from-stdin\n', 'utf8').toString('base64')
              );
              cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitFileDeleteNative?.(
                null,
                'stale.txt'
              );
              return JSON.stringify({
                success: true,
                output: JSON.stringify(JSON.stringify({
                  stdout,
                  stderr,
                  exitCode: 0,
                })),
                compilerStdout: '',
                compilerStderr: '',
                changedFiles: [
                  { path: 'generated.txt', contents: Buffer.from('created\n', 'utf8').toString('base64'), encoding: 'base64' },
                  { path: 'writer.txt', contents: Buffer.from('writer\n', 'utf8').toString('base64'), encoding: 'base64' },
                  { path: 'printed.txt', contents: Buffer.from('printed\n', 'utf8').toString('base64'), encoding: 'base64' },
                  { path: 'ps-file.txt', contents: Buffer.from('ps-file\n', 'utf8').toString('base64'), encoding: 'base64' },
                  { path: 'stream.bin', contents: Buffer.from([0, 254]).toString('base64'), encoding: 'base64' },
                  { path: 'data.bin', contents: Buffer.from([0, 253]).toString('base64'), encoding: 'base64' },
                  { path: 'nio-created.txt', contents: '', encoding: 'base64' },
                  { path: 'nio-stream.bin', contents: Buffer.from([0, 252]).toString('base64'), encoding: 'base64' },
                  { path: 'nio-writer.txt', contents: Buffer.from('nio-writer\n', 'utf8').toString('base64'), encoding: 'base64' },
                  { path: 'byte-channel.bin', contents: Buffer.from([0, 7, 6]).toString('base64'), encoding: 'base64' },
                  { path: 'empty-nio-stream.bin', contents: '', encoding: 'base64' },
                  { path: 'empty-nio-writer.txt', contents: '', encoding: 'base64' },
                  { path: 'empty-nio-channel.bin', contents: '', encoding: 'base64' },
                  { path: 'random.bin', contents: Buffer.from([0, 9, 8]).toString('base64'), encoding: 'base64' },
                  { path: 'classic-created.txt', contents: '', encoding: 'base64' },
                  { path: 'classic-metadata.txt', contents: '', encoding: 'base64' },
                  { path: 'classic-renamed.txt', contents: Buffer.from('classic\n', 'utf8').toString('base64'), encoding: 'base64' },
                  { path: 'stdin-copy.txt', contents: Buffer.from('from-stdin\n', 'utf8').toString('base64'), encoding: 'base64' },
                  { path: 'empty-open-writer.txt', contents: '', encoding: 'base64' },
                  { path: 'empty-open-stream.bin', contents: '', encoding: 'base64' },
                  { path: 'writer-before-output.txt', contents: Buffer.from('before-output\n', 'utf8').toString('base64'), encoding: 'base64' },
                  { path: 'bytes.bin', contents: Buffer.from([0, 255]).toString('base64'), encoding: 'base64' },
                  { path: 'classic-delete.txt', deleted: true },
                  { path: 'stale.txt', deleted: true },
                ],
                compileTimeMs: 1,
                classLoadTimeMs: 1,
                runTimeMs: 1,
                compileCacheHit: true,
                compilerDebugProfile: compilerProfile,
              });
            },
            compileProjectSourcesWithResources: async (
              sourceManifest: string,
              _sourceRoot: string,
              resourceManifest: string,
              _resourceRoot: string,
              compileSourcePaths: string,
              compileSourceRootPaths: string,
              _classesDir: string,
              compileClasspath: string,
              compilerProfile: string
            ) => {
              projectCompileCalls.push({ sourcePaths: sourceManifest, mainClassName: '<javac>', resourceManifest, compileClasspath, compileSourcePaths, compileSourceRootPaths });
              const compiledPath = sourceManifest.includes('java/TicketTriage.java') ? 'TicketTriage.class' : 'app/Main.class';
              return JSON.stringify({
                success: true,
                output: JSON.stringify({
                  stdout: '',
                  stderr: '',
                  exitCode: 0,
                }),
                compilerStdout: '',
                compilerStderr: '',
                compiledFiles: [
                  { path: compiledPath, contents: 'yv66vg==', encoding: 'base64' },
                ],
                compileTimeMs: 1,
                classLoadTimeMs: 0,
                runTimeMs: 0,
                compileCacheHit: false,
                compilerDebugProfile: compilerProfile,
              });
            },
            compileAndRunProjectClassFiles: async (
              classManifest: string,
              _classRoot: string,
              _sourceManifest: string,
              _sourceRoot: string,
              _classesDir: string,
              mainClassName: string,
              runtimeClasspath: string,
              _compileClasspath: string,
              compilerProfile: string
            ) => {
              projectClassCompileCalls.push({ classManifest, mainClassName, runtimeClasspath, sourceManifest: _sourceManifest });
              return JSON.stringify({
                success: true,
                output: JSON.stringify(JSON.stringify({
                  stdout: '5\njava_args=alpha,beta\n',
                  stderr: '',
                  exitCode: 0,
                })),
                compilerStdout: '',
                compilerStderr: '',
                compileTimeMs: 1,
                classLoadTimeMs: 1,
                runTimeMs: 1,
                compileCacheHit: false,
                compilerDebugProfile: compilerProfile,
              });
            },
            compileAndRunProjectClassFilesWithWorkspace: async (
              classManifest: string,
              _classRoot: string,
              _sourceManifest: string,
              _sourceRoot: string,
              workspaceManifest: string,
              workspaceRoot: string,
              workspaceCwd: string,
              _classesDir: string,
              mainClassName: string,
              runtimeClasspath: string,
              _compileClasspath: string,
              compilerProfile: string
            ) => {
              projectClassCompileCalls.push({ classManifest, mainClassName, runtimeClasspath, sourceManifest: _sourceManifest, workspaceManifest, workspaceRoot, workspaceCwd });
              return JSON.stringify({
                success: true,
                output: JSON.stringify(JSON.stringify({
                  stdout: '5\njava_args=alpha,beta\n',
                  stderr: '',
                  exitCode: 0,
                })),
                compilerStdout: '',
                compilerStderr: '',
                changedFiles: [
                  { path: 'generated.txt', contents: Buffer.from('created\n', 'utf8').toString('base64'), encoding: 'base64' },
                ],
                compileTimeMs: 1,
                classLoadTimeMs: 1,
                runTimeMs: 1,
                compileCacheHit: false,
                compilerDebugProfile: compilerProfile,
              });
            },
            compileAndRunBatch: async (
              _sourcePath: string,
              _classesDir: string,
              entryClasses: string,
              _compileClasspath: string,
              compilerProfile: string
            ) => {
              const entries = entryClasses.split('\n').filter(Boolean);
              return JSON.stringify({
                success: true,
                results: entries.map((_entry, index) => ({
                  success: true,
                  output: JSON.stringify(index + 1),
                  classLoadTimeMs: 1,
                  runTimeMs: 1,
                })),
                compilerStdout: '',
                compilerStderr: '',
                compileTimeMs: 1,
                compileCacheHit: true,
                compilerDebugProfile: compilerProfile,
              });
            },
          },
        },
      },
      harness: {
        browser: {
          JavaRewriteLibrary: {
            rewriteSource: async (
              source: string,
              executionStyle: string,
              entryName: string,
              exportsSource: string,
              exportsClassName: string,
              packageName: string
            ) => {
              rewriteCalls.push({ source, executionStyle, entryName, exportsSource, exportsClassName, packageName });
              if (source.includes('rewriteProbeClassNotFoundRegression')) {
                throw new Error('Java syntax error.');
              }
              if (source.includes('lowerBound')) {
                return `package ${packageName};
import tracecode.user.TraceHooks;

class Solution {
  static int lowerBound(int[] nums, int target) {
    TraceHooks.emitCallAtLine(3, "lowerBound", " target=" + target);
    TraceHooks.emitLineAtLine(4);
    int left = 0;
    TraceHooks.emitLineAtLine(4, "left=" + left);
    TraceHooks.emitLineAtLine(5);
    int right = nums.length;
    TraceHooks.emitLineAtLine(5, "right=" + right);
    TraceHooks.emitLineAtLine(6);
    while (left < right) {
      TraceHooks.emitLineAtLine(7);
      int mid = left + (right - left) / 2;
      TraceHooks.emitLineAtLine(7, "mid=" + mid);
      TraceHooks.emitLineAtLine(8);
      if (TraceHooks.readIntArrayAtLine(8, "nums", nums, mid, "mid") < target)
        left = mid + 1;
      else
        right = mid;
    }
    TraceHooks.emitReturnAtLine(11, "lowerBound");
    return left;
  }
}

${exportsSource.replace('public class Exports', `public class ${exportsClassName}`)}`;
              }
              if (source.includes('twoSum')) {
                return `package ${packageName};
import tracecode.user.TraceHooks;
import java.util.*;

class Solution {
  public int[] twoSum(int[] nums, int target) {
    TraceHooks.emitCallAtLine(4, "twoSum", "");
    TraceHooks.emitLineAtLine(5);
    Map<Integer, Integer> seen = new HashMap<>();
    TraceHooks.emitLineAtLine(6);
    for (int i = 0; i < nums.length; i++) {
      TraceHooks.emitLineAtLine(7);
      int complement = target - TraceHooks.readIntArrayAtLine(7, "nums", nums, i, "i");
      TraceHooks.emitLineAtLine(8);
      if (seen.containsKey(complement)) {
        TraceHooks.emitLineAtLine(9);
        int[] out = new int[] { seen.get(complement), i };
        TraceHooks.emitReturnAtLine(9, "twoSum");
        return out;
      }
      TraceHooks.emitLineAtLine(11);
      seen.put(TraceHooks.readIntArrayAtLine(11, "nums", nums, i, "i"), i);
      TraceHooks.emitMutatingCallAtLine(11, "seen", "put");
    }
    TraceHooks.emitReturnAtLine(13, "twoSum");
    return new int[0];
  }
}

${exportsSource.replace('public class Exports', `public class ${exportsClassName}`)}`;
              }
              if (source.includes('buildGraph')) {
                return `package ${packageName};
import tracecode.user.TraceHooks;
import java.util.*;

class Solution {
  int[] buildGraph(int n) {
    TraceHooks.emitCallAtLine(4, "buildGraph", "");
    TraceHooks.emitLineAtLine(5);
    List<List<Integer>> graph = new ArrayList<>();
    TraceHooks.emitLineAtLine(6);
    for (int i = 0; i < n; i++) graph.add(new ArrayList<>());
    TraceHooks.emitLineAtLine(7);
    graph.get(0).add(1);
    TraceHooks.emitMutatingCallAtLine(7, "graph", "add");
    TraceHooks.emitLineAtLine(8);
    graph.get(1).add(2);
    TraceHooks.emitMutatingCallAtLine(8, "graph", "add");
    TraceHooks.emitLineAtLine(10);
    int[] order = new int[n];
    TraceHooks.emitLineAtLine(11);
    for (int u = 0; u < n; u++) {
      TraceHooks.emitLineAtLine(12);
      for (int v : graph.get(u)) {
        TraceHooks.emitLineAtLine(13);
        order[v] = v;
        TraceHooks.emitArrayWriteAtLine(13, "order", v, order[v]);
      }
    }
    TraceHooks.emitReturnAtLine(16, "buildGraph");
    return order;
  }
}

${exportsSource.replace('public class Exports', `public class ${exportsClassName}`)}`;
              }
              if (source.includes('values.add(n)')) {
                return `package ${packageName};
import tracecode.user.TraceHooks;
import java.util.*;

class Solution {
  private List<Integer> values;

  public int solve(int n) {
    TraceHooks.emitCallAtLine(6, "solve", "");
    TraceHooks.emitLineAtLine(7);
    values = new ArrayList<>();
    TraceHooks.emitLineAtLine(8);
    values.add(n); TraceHooks.emit("trace:{\\"kind\\":\\"mutate\\",\\"line\\":8,\\"target\\":{\\"variable\\":\\"this\\",\\"path\\":[\\"values\\"]},\\"method\\":\\"add\\"}");
    TraceHooks.emitLineAtLine(9);
    TraceHooks.emitReturnAtLine(9, "solve");
    return values.size();
  }
}

${exportsSource.replace('public class Exports', `public class ${exportsClassName}`)}`;
              }
              if (source.includes('legacySnapshot')) {
                return `package ${packageName};
import tracecode.user.TraceHooks;

class Solution {
  public int legacySnapshot() {
    TraceHooks.emitCallAtLine(4, "legacySnapshot", "");
    TraceHooks.emitLineAtLine(5);
    Object box = new Object();
    TraceHooks.emitRuntimeSnapshotAtLine(5, "box", box);
    TraceHooks.emitReturnAtLine(6, "legacySnapshot");
    return 1;
  }
}

${exportsSource.replace('public class Exports', `public class ${exportsClassName}`)}`;
              }
              return `package ${packageName};\n${source}\n${exportsSource.replace('public class Exports', `public class ${exportsClassName}`)}`;
            },
          },
        },
      },
      };
    },
    close: () => {},
  };

  const context = vm.createContext({
    btoa: (value: string) => Buffer.from(value, 'binary').toString('base64'),
    console,
    self: selfObject,
    performance: { now: () => Date.now() },
    setTimeout,
    clearTimeout,
    TextEncoder,
    queueMicrotask,
  });

  vm.runInContext(workerSource, context, {
    filename: 'java-worker.js',
  });

  const onmessage = selfObject.onmessage;
  assertCondition(typeof onmessage === 'function', 'Worker did not register onmessage handler');

  async function sendMessage<T>(type: string, payload?: unknown): Promise<T> {
    const id = String(++nextId);
    const protocolToken = `java-test-token-${id}`;
    const responsePromise = new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        reject(new Error(`Timed out waiting for response: ${type}`));
      }, 5000);
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeoutId, protocolToken, events: [] });
    });

    onmessage?.({ data: { id, type, payload, protocolToken } });
    return responsePromise;
  }

  function terminate(): void {
    onmessage?.({ data: { type: 'terminate' } });
  }

  return { httpDispatches, projectClassCompileCalls, projectCompileCalls, rewriteCalls, runLibraryClasspaths, sendMessage, stringFiles, terminate };
}

async function main(): Promise<void> {
  testJavaHelperJarDoesNotExposeDeprecatedSpikePackages();
  testNativeJavaRewriterRegressionGaps();
  testJavaRuntimeValueSerializationLimit();
  testJavaRuntimeUserObjectSerializationIds();
  testJavaBrowserHelperWorkspaceDirectories();
  testJavaProjectEventsRandomAccessKernelReads();
  testJavaProjectEventsHttpClientShims();
  testJavaRuntimeMultiSnapshotFragments();
  testJavaEnhancedForHeaderExpansionDropsStaleBindingSnapshots();
  testJavaRuntimeRecursiveCallStacks();
  testJavaRuntimeMutationHooksEmitPostSnapshots();
  testJavaArraySortHooksEmitIndexedWrites();
  testJavaListSortHooksEmitIndexedWrites();

  const workerSource = await loadWorkerSource();
  const augmentationSource = await loadJavaSourceAugmentationSource();
  const harness = createWorkerHarness(workerSource, augmentationSource);

  try {
    const init = await harness.sendMessage<{ success: boolean; loadTimeMs: number }>('init');
    assertCondition(init.success === true, 'Init should succeed');
    assertCondition(
      harness.runLibraryClasspaths.length === 0,
      'Java worker init should not load the CheerpJ Java library bridge'
    );
    assertCondition(
      !harness.stringFiles.some((file) => file.path.includes('__warm')),
      'Java worker init should not compile warmup sources'
    );
    console.log('PASS: java worker init with mocked CheerpJ bridge');

    const warmup = await harness.sendMessage<{ success: boolean; loadTimeMs: number; timings?: Record<string, unknown> }>('warmup');
    assertCondition(warmup.success === true, 'Java worker warmup should succeed');
    assertCondition(
      harness.runLibraryClasspaths.length === 1,
      'Java worker warmup should load the CheerpJ Java library bridge once'
    );
    assertCondition(
      harness.stringFiles.some((file) => file.path.includes('__warm_run__') || file.source.includes('ExportsTracecodeRunWarmup')),
      'Java worker warmup should compile the run warmup source'
    );
    assertCondition(
      harness.rewriteCalls.length === 0,
      'Java worker warmup should not call the trace rewriter'
    );
    console.log('PASS: java worker warmup lazily loads the run path');

    const rewriteCallCountBeforePlainExecute = harness.rewriteCalls.length;
    const plainExecute = await harness.sendMessage<{
      success: boolean;
      events?: string[];
      sourceText?: string;
    }>('execute-code', {
      code: `class Solution {
  int add(int a, int b) {
    return a + b;
  }
}`,
      functionName: 'add',
      inputs: { a: 1, b: 2 },
      executionStyle: 'function',
    });

    assertCondition(plainExecute.success === true, 'Java execute-code should succeed on the non-trace path');
    assertCondition(plainExecute.events === undefined, 'Java execute-code should not return trace events');
    assertCondition(plainExecute.sourceText === undefined, 'Java execute-code should not return trace source text');
    assertCondition(
      harness.rewriteCalls.length === rewriteCallCountBeforePlainExecute,
      'Java execute-code should not call the trace rewriter'
    );
    const plainExecuteSource = latestSourceContaining(harness.stringFiles, 'solution.add(a, b)');
    assertCondition(
      plainExecuteSource.includes('class Solution') &&
        !plainExecuteSource.includes('TraceHooks.emitCallAtLine') &&
        !plainExecuteSource.includes('TraceHooks.emitLineAtLine'),
      'Java execute-code should compile an uninstrumented runnable source'
    );
    console.log('PASS: java execute-code uses dedicated non-trace worker path');

    const defaultImportExecute = await harness.sendMessage<{ success: boolean }>('execute-code', {
      code: `class Solution {
  int useDefaults() {
    Pair<Integer, Integer> pair = new Pair<>(2, 3);
    List<Integer> values = new ArrayList<>();
    BigInteger total = BigInteger.valueOf(pair.getKey() + pair.getValue() + values.size());
    return total.intValue();
  }
}`,
      functionName: 'useDefaults',
      inputs: {},
      executionStyle: 'function',
    });
    assertCondition(defaultImportExecute.success === true, 'Java execute-code with default imports should succeed');
    const defaultImportSource = latestSourceContaining(harness.stringFiles, 'new Pair<>(2, 3)');
    assertCondition(
      defaultImportSource.includes('import java.util.*;') &&
        defaultImportSource.includes('import java.math.*;') &&
        defaultImportSource.includes('import javafx.util.Pair;'),
      'Java runnable source should inject default imports before user code'
    );
    assertJavaSourceCompiles(defaultImportSource, 'Java runnable source with default imports and javafx.util.Pair');
    console.log('PASS: java worker injects default imports and Pair helper');

    const projectExecute = await harness.sendMessage<{
      stdout: string;
      stderr: string;
      exitCode: number;
      files?: Array<{ path: string; contents?: string; encoding?: string; deleted?: true; directory?: true }>;
      events?: Array<{
        type: string;
        stream?: 'stdout' | 'stderr';
        device?: string;
        sourceDevice?: string;
        data?: string;
        phase?: string;
        change?: { path: string; contents?: string; encoding?: string; deleted?: true; directory?: true };
      }>;
    }>('execute-project-java', {
      code: '',
      source: 'run',
      scriptPath: 'Main',
      args: ['alpha', 'beta'],
      cwd: '/workspace',
      env: {},
      stdinPipe: createRuntimeCommandStdinPipeFromText('from-stdin\n'),
      project: {
        directories: ['empty/child'],
        files: [
          { path: 'Helper.java', contents: 'class Helper { static int add(int a, int b) { return a + b; } }\n' },
          {
            path: 'Main.java',
            contents: [
              'import java.io.*;',
              'import java.nio.ByteBuffer;',
              'import java.nio.charset.StandardCharsets;',
              'import java.nio.file.*;',
              'import java.util.EnumSet;',
              'import java.util.stream.Collectors;',
              'class Main {',
              '  public static void main(String[] args) throws Exception {',
              '    Files.writeString(Path.of("generated.txt"), "created\\n");',
              '    try (var writer = new FileWriter("writer.txt")) { writer.write("writer\\n"); }',
              '    try (var writer = new PrintWriter("printed.txt")) { writer.println("printed"); }',
              '    try (var stream = new FileOutputStream("stream.bin")) { stream.write(new byte[] { 0, (byte)254 }); }',
              '    try (var stream = new DataOutputStream(new FileOutputStream("data.bin"))) { stream.write(new byte[] { 0, (byte)253 }); }',
              '    try (var stream = new PrintStream("ps-file.txt")) { stream.println("ps-file"); }',
              '    Files.createFile(Path.of("nio-created.txt"));',
              '    Files.setLastModifiedTime(Path.of("nio-created.txt"), java.nio.file.attribute.FileTime.fromMillis(1L));',
              '    Files.setAttribute(Path.of("nio-created.txt"), "basic:lastModifiedTime", java.nio.file.attribute.FileTime.fromMillis(2L));',
              '    Files.createDirectories(Path.of("live-dir/child"));',
              '    Path tempRoot = Path.of("temp-root");',
              '    Files.createDirectories(tempRoot);',
              '    Files.createTempFile(tempRoot, "case", ".txt");',
              '    Files.createTempDirectory(tempRoot, "child");',
              '    Files.move(Path.of("live-dir/child"), Path.of("live-dir/renamed-child"));',
              '    Files.delete(Path.of("live-dir/renamed-child"));',
              '    Files.delete(Path.of("live-dir"));',
              '    try (var stream = Files.newOutputStream(Path.of("nio-stream.bin"))) { stream.write(new byte[] { 0, (byte)252 }); }',
              '    try (var writer = Files.newBufferedWriter(Path.of("nio-writer.txt"))) { writer.write("nio-writer\\n"); }',
              '    var liveNioWriter = Files.newBufferedWriter(Path.of("nio-writer-before-output.txt"));',
              '    liveNioWriter.write("nio-before-output\\\\n");',
              '    System.out.println("after-nio-writer-live");',
              '    liveNioWriter.close();',
              '    try (var channel = Files.newByteChannel(Path.of("byte-channel.bin"), EnumSet.of(StandardOpenOption.CREATE, StandardOpenOption.WRITE, StandardOpenOption.TRUNCATE_EXISTING))) { channel.write(ByteBuffer.wrap(new byte[] { 0, 7, 6, 5 })); channel.truncate(3); }',
              '    var emptyNioStream = Files.newOutputStream(Path.of("empty-nio-stream.bin"));',
              '    System.out.println("after-empty-nio-stream");',
              '    emptyNioStream.close();',
              '    var emptyNioWriter = Files.newBufferedWriter(Path.of("empty-nio-writer.txt"));',
              '    System.out.println("after-empty-nio-writer");',
              '    emptyNioWriter.close();',
              '    var emptyNioChannel = Files.newByteChannel(Path.of("empty-nio-channel.bin"), EnumSet.of(StandardOpenOption.CREATE, StandardOpenOption.WRITE, StandardOpenOption.TRUNCATE_EXISTING));',
              '    System.out.println("after-empty-nio-channel");',
              '    emptyNioChannel.close();',
              '    try (var raf = new RandomAccessFile("random.bin", "rw")) { raf.write(new byte[] { 0, 1, 2, 3 }); raf.seek(1); raf.write(new byte[] { 9, 8 }); raf.setLength(3); }',
              '    new File("classic-created.txt").createNewFile();',
              '    var classicMetadata = new File("classic-metadata.txt");',
              '    classicMetadata.createNewFile();',
              '    classicMetadata.setLastModified(1L);',
              '    classicMetadata.setReadOnly();',
              '    new File("classic-dir/child").mkdirs();',
              '    new File("classic-dir/child").renameTo(new File("classic-dir/renamed-child"));',
              '    new File("classic-dir/renamed-child").delete();',
              '    new File("classic-dir").delete();',
              '    try (var writer = new FileWriter("classic-rename-source.txt")) { writer.write("classic\\n"); }',
              '    new File("classic-rename-source.txt").renameTo(new File("classic-renamed.txt"));',
              '    new File("classic-delete.txt").createNewFile();',
              '    new File("classic-delete.txt").delete();',
              '    Files.copy(Path.of("/dev/stdin"), Path.of("stdin-copy.txt"), StandardCopyOption.REPLACE_EXISTING);',
              '    Files.copy(Path.of("stdin-copy.txt"), Path.of("/dev/stdout"), StandardCopyOption.REPLACE_EXISTING);',
              '    Files.deleteIfExists(Path.of("stale.txt"));',
              '    var emptyOpenWriter = new FileWriter("empty-open-writer.txt");',
              '    System.out.println("after-empty-open-writer");',
              '    emptyOpenWriter.close();',
              '    var emptyOpenStream = new FileOutputStream("empty-open-stream.bin");',
              '    System.out.println("after-empty-open-stream");',
              '    emptyOpenStream.close();',
              '    var liveWriter = new FileWriter("writer-before-output.txt");',
              '    liveWriter.write("before-output\\\\n");',
              '    System.out.println("after-filewriter-live");',
              '    liveWriter.close();',
              '    System.out.println(Helper.add(2, 3));',
              '    System.out.println("java_args=" + String.join(",", args));',
              '    System.out.println("java_stdin=" + new BufferedReader(new InputStreamReader(System.in)).readLine());',
              '    System.out.println(Files.readString(Path.of("/proc/kernel/info")).contains("tracekernel") ? "proc-info" : "proc-missing");',
              '    try (var stream = new FileInputStream("/proc/kernel/version")) { System.out.println("proc-stream=" + new String(stream.readAllBytes(), StandardCharsets.UTF_8).trim()); }',
              '    try (var random = new RandomAccessFile("/proc/kernel/version", "r")) { byte[] bytes = new byte[(int) random.length()]; random.readFully(bytes); System.out.println("proc-random=" + new String(bytes, StandardCharsets.UTF_8).trim()); }',
              '    try { Files.writeString(Path.of("/proc/kernel/info"), "{}\\\\n"); System.out.println("proc-write:ok"); } catch (IOException ex) { System.out.println("proc-write:" + ex.getClass().getSimpleName()); }',
              '    try (var paths = Files.list(Path.of("/proc/kernel"))) { System.out.println("proc-list=" + paths.map(path -> path.getFileName().toString()).sorted().collect(Collectors.joining(","))); }',
              '    System.out.println("proc-stat=" + Files.isReadable(Path.of("/proc/kernel/info")) + ":" + Files.isWritable(Path.of("/proc/kernel/info")) + ":" + Files.size(Path.of("/proc/kernel/info")));',
              '    System.out.println("custom-kernel=" + Files.readString(Path.of("/tracekernel/custom")).trim());',
              '    try (var random = new RandomAccessFile("/tracekernel/custom", "r")) { byte[] bytes = new byte[(int) random.length()]; random.readFully(bytes); System.out.println("custom-kernel-random=" + new String(bytes, StandardCharsets.UTF_8).trim()); }',
              '    try { Files.writeString(Path.of("/tracekernel/custom"), "bad\\\\n"); System.out.println("custom-kernel-write:ok"); } catch (IOException ex) { System.out.println("custom-kernel-write:" + ex.getClass().getSimpleName()); }',
              '    try { Files.createDirectories(Path.of("/tracekernel/new")); System.out.println("custom-kernel-mkdir:ok"); } catch (IOException ex) { System.out.println("custom-kernel-mkdir:" + ex.getClass().getSimpleName()); }',
              '    var customKernelFile = new File("/tracekernel/custom");',
              '    System.out.println("custom-kernel-file-api=" + new File("/tracekernel").isDirectory() + ":" + customKernelFile.isFile() + ":" + customKernelFile.canRead() + ":" + customKernelFile.canWrite());',
              '    try (var paths = Files.list(Path.of("/dev"))) { System.out.println("dev-list=" + paths.map(path -> path.getFileName().toString()).sorted().collect(Collectors.joining(","))); }',
              '    try (var paths = Files.newDirectoryStream(Path.of("/dev"))) { var names = new java.util.ArrayList<String>(); for (var path : paths) names.add(path.getFileName().toString()); java.util.Collections.sort(names); System.out.println("dev-stream=" + String.join(",", names)); }',
              '    try (var paths = Files.newDirectoryStream(Path.of("/dev"), "std*")) { var names = new java.util.ArrayList<String>(); for (var path : paths) names.add(path.getFileName().toString()); java.util.Collections.sort(names); System.out.println("dev-glob=" + String.join(",", names)); }',
              '    try (var paths = Files.newDirectoryStream(Path.of("/dev"), path -> path.getFileName().toString().contains("out") || path.getFileName().toString().contains("err"))) { var names = new java.util.ArrayList<String>(); for (var path : paths) names.add(path.getFileName().toString()); java.util.Collections.sort(names); System.out.println("dev-filter=" + String.join(",", names)); }',
              '    System.out.println("dev-stat=" + Files.isDirectory(Path.of("/dev")) + ":" + Files.isRegularFile(Path.of("/dev/stdout")) + ":" + Files.exists(Path.of("/dev/stdin")) + ":" + Files.exists(Path.of("/dev/missing")));',
              '    System.out.println("dev-nio-stat=" + Files.isReadable(Path.of("/dev/stdin")) + ":" + Files.isWritable(Path.of("/dev/stdin")) + ":" + Files.isReadable(Path.of("/dev/stdout")) + ":" + Files.isWritable(Path.of("/dev/stdout")) + ":" + Files.size(Path.of("/dev/stdout")));',
              '    System.out.println("dev-custom=" + Files.readString(Path.of("/dev/custom-in")).trim() + ":" + Files.exists(Path.of("/dev/log")));',
              '    System.out.println("dev-null=" + Files.readAllBytes(Path.of("/dev/null")).length);',
              '    Files.writeString(Path.of("/dev/null"), "discarded\\\\n");',
              '    try { Files.deleteIfExists(Path.of("/dev/stdout")); System.out.println("dev-delete:ok"); } catch (IOException ex) { System.out.println("dev-delete:" + ex.getClass().getSimpleName()); }',
              '    System.out.println("dev_stdin=" + Files.readString(Path.of("/dev/stdin")).trim());',
              '    try (var stream = new FileInputStream("/dev/stdin")) { System.out.println("dev_stream_stdin=" + new String(stream.readAllBytes(), StandardCharsets.UTF_8).trim()); }',
              '    try (var reader = new FileReader("/dev/stdin", StandardCharsets.UTF_8)) { System.out.println("dev_reader_stdin=" + new BufferedReader(reader).readLine()); }',
              '    try (var stream = Files.newInputStream(Path.of("/dev/stdin"))) { System.out.println("dev_nio_stream_stdin=" + new String(stream.readAllBytes(), StandardCharsets.UTF_8).trim()); }',
              '    try (var reader = Files.newBufferedReader(Path.of("/dev/stdin"), StandardCharsets.UTF_8)) { System.out.println("dev_nio_reader_stdin=" + reader.readLine()); }',
              '    System.out.println("dev_read_all_lines=" + String.join(",", Files.readAllLines(Path.of("/dev/stdin"), StandardCharsets.UTF_8)));',
              '    try (var lines = Files.lines(Path.of("/dev/stdin"), StandardCharsets.UTF_8)) { System.out.println("dev_lines=" + lines.collect(Collectors.joining(","))); }',
              '    try (var channel = Files.newByteChannel(Path.of("/dev/stdin"), StandardOpenOption.READ)) { var bytes = ByteBuffer.allocate(64); channel.read(bytes); bytes.flip(); System.out.println("dev_channel_stdin=" + StandardCharsets.UTF_8.decode(bytes).toString().trim()); }',
              '    try (var random = new RandomAccessFile("/dev/stdin", "r")) { byte[] bytes = new byte[(int) random.length()]; random.readFully(bytes); System.out.println("dev_random_stdin=" + new String(bytes, StandardCharsets.UTF_8).trim()); }',
              '    try (var stream = new FileInputStream("/dev/custom-in")) { System.out.println("dev_stream_custom=" + new String(stream.readAllBytes(), StandardCharsets.UTF_8).trim()); }',
              '    try (var reader = new FileReader("/dev/custom-in")) { System.out.println("dev_reader_custom=" + new BufferedReader(reader).readLine()); }',
              '    Files.writeString(Path.of("/dev/stdout"), "dev_stdout\\\\n");',
              '    try (var stream = new FileOutputStream("/dev/stdout")) { stream.write("fos_stdout\\\\n".getBytes(StandardCharsets.UTF_8)); }',
              '    try (var stream = new FileOutputStream(FileDescriptor.out)) { stream.write("fd_stdout\\\\n".getBytes(StandardCharsets.UTF_8)); }',
              '    try (var writer = new FileWriter(FileDescriptor.out)) { writer.write("fd_writer_stdout\\\\n"); }',
              '    try (var stream = new FileInputStream(FileDescriptor.in)) { System.out.println("fd_stdin=" + new String(stream.readAllBytes(), StandardCharsets.UTF_8).trim()); }',
              '    try (var reader = new FileReader(FileDescriptor.in)) { char[] buffer = new char[64]; System.out.println("fd_reader_stdin=" + new String(buffer, 0, reader.read(buffer)).trim()); }',
              '    try (var writer = new FileWriter("/dev/stdout", StandardCharsets.UTF_8)) { writer.write("dev_writer\\\\n"); }',
              '    try (var writer = new PrintWriter("/dev/stdout", StandardCharsets.UTF_8)) { writer.print("pw_stdout\\\\n"); }',
              '    try (var writer = new FileWriter("/dev/tty", StandardCharsets.UTF_8)) { writer.write("fw_tty\\\\n"); }',
              '    Files.writeString(Path.of("/dev/tty"), "dev_tty\\\\n");',
              '    Files.writeString(Path.of("/dev/log"), "dev_log\\\\n");',
              '    try (var writer = new PrintWriter("/dev/log", StandardCharsets.UTF_8)) { writer.print("pw_log\\\\n"); }',
              '    Files.writeString(Path.of("/dev/capture"), "capture-device");',
              '    Files.writeString(Path.of("/dev/stdout"), "stdout-after-capture\\\\n");',
              '    Files.writeString(Path.of("/dev/tee"), "tee-device");',
              '    Files.writeString(Path.of("/dev/stdout"), "stdout-after-tee\\\\n");',
              '    Files.writeString(Path.of("/dev/stderr"), "dev_stderr\\\\n");',
              '    try (var stream = new FileOutputStream(FileDescriptor.err)) { stream.write("fd_stderr\\\\n".getBytes(StandardCharsets.UTF_8)); }',
              '    try (var stream = new PrintStream("/dev/stderr", "UTF-8")) { stream.print("ps_stderr\\\\n"); }',
              '    try { Files.readString(Path.of("/dev/stdout")); System.out.println("stdout-read:ok"); } catch (IOException ex) { System.out.println("stdout-read:" + ex.getClass().getSimpleName()); }',
              '    try { new FileInputStream("/dev/stdout").close(); System.out.println("stdout-stream-read:ok"); } catch (IOException ex) { System.out.println("stdout-stream-read:" + ex.getClass().getSimpleName()); }',
              '    try { new FileReader("/dev/stdout").close(); System.out.println("stdout-reader-read:ok"); } catch (IOException ex) { System.out.println("stdout-reader-read:" + ex.getClass().getSimpleName()); }',
              '    try { Files.newInputStream(Path.of("/dev/stdout")).close(); System.out.println("stdout-nio-stream-read:ok"); } catch (IOException ex) { System.out.println("stdout-nio-stream-read:" + ex.getClass().getSimpleName()); }',
              '  }',
              '}',
              '',
            ].join('\n'),
          },
        ],
        kernelFiles: [
          { path: '/proc/kernel/info', contents: '{\n  "name": "tracekernel"\n}\n' },
          { path: '/proc/kernel/version', contents: 'tracekernel test\n' },
          { path: '/proc/self/mountinfo', contents: '26 0 0:3 / /proc rw,nosuid,nodev,noexec - tracefs tracekernel:proc rw\n' },
          { path: '/tracekernel/custom', contents: 'custom-kernel-file\n' },
        ],
        kernelDevices: [
          { path: '/dev/stdin', readable: true, writable: false, inputDevice: '/dev/stdin' },
          { path: '/dev/stdout', readable: false, writable: true, outputDevice: '/dev/stdout' },
          { path: '/dev/stderr', readable: false, writable: true, outputDevice: '/dev/stderr' },
          { path: '/dev/null', readable: true, writable: true, inputDevice: '/dev/null', outputDevice: '/dev/null' },
          { path: '/dev/tty', readable: true, writable: true, inputDevice: '/dev/stdin', outputDevice: '/dev/stdout' },
          { path: '/dev/log', readable: false, writable: true, outputDevice: '/dev/stderr' },
          { path: '/dev/capture', readable: false, writable: true, outputDevice: '/dev/capture' },
          { path: '/dev/tee', readable: false, writable: true, outputDevice: '/dev/capture' },
          { path: '/dev/custom-in', readable: true, writable: false, inputDevice: '/dev/stdin' },
          { path: '/dev/nested/path', readable: false, writable: true, outputDevice: '/dev/stdout' },
        ],
      },
    });
    assertCondition(projectExecute.exitCode === 0, 'Java execute-project-java should succeed');
    assertCondition(
      projectExecute.stdout === 'after-nio-writer-live\nafter-empty-nio-stream\nafter-empty-nio-writer\nafter-empty-nio-channel\nafter-empty-open-writer\nafter-empty-open-stream\nafter-filewriter-live\n5\njava_args=alpha,beta\njava_stdin=from-stdin\nproc-info\nproc-stream=tracekernel test\nproc-random=tracekernel test\nproc-write:IOException\nproc-list=info,version\nproc-stat=true:false:28\ncustom-kernel=custom-kernel-file\ncustom-kernel-random=custom-kernel-file\ncustom-kernel-write:IOException\ncustom-kernel-mkdir:IOException\ncustom-kernel-file-api=true:true:true:false\ndev-list=capture,custom-in,log,null,stderr,stdin,stdout,tee,tty\ndev-stream=capture,custom-in,log,null,stderr,stdin,stdout,tee,tty\ndev-glob=stderr,stdin,stdout\ndev-filter=stderr,stdout\ndev-stat=true:true:true:false\ndev-nio-stat=true:false:false:true:0\ndev-custom=from-stdin:true\ndev-null=0\ndev-delete:IOException\ndev_stdin=from-stdin\ndev_stream_stdin=from-stdin\ndev_reader_stdin=from-stdin\ndev_nio_stream_stdin=from-stdin\ndev_nio_reader_stdin=from-stdin\ndev_read_all_lines=from-stdin\ndev_lines=from-stdin\ndev_channel_stdin=from-stdin\ndev_random_stdin=from-stdin\ndev_stream_custom=from-stdin\ndev_reader_custom=from-stdin\ndev_stdout\nfos_stdout\nfd_stdout\nfd_writer_stdout\nfd_stdin=from-stdin\ndev_writer\npw_stdout\nfw_tty\ndev_tty\ncapture-devicestdout-after-capture\ntee-devicestdout-after-tee\nfrom-stdin\nstdout-read:IOException\nstdout-stream-read:IOException\nstdout-reader-read:IOException\nstdout-nio-stream-read:IOException\n',
      `Java execute-project-java should return captured stdout: ${JSON.stringify({ stdout: projectExecute.stdout, stderr: projectExecute.stderr })}`
    );
    assertCondition(projectExecute.stderr === 'dev_log\npw_log\ndev_stderr\nfd_stderr\nps_stderr\n', 'Java execute-project-java should capture /dev/stderr writes');
    assertCondition(
      projectExecute.events?.some(
        (event) =>
          event.type === 'output' &&
          event.stream === 'stdout' &&
          event.data === '5\n'
      ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'output' &&
            event.stream === 'stdout' &&
            event.data === 'java_args=alpha,beta\n'
      ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'output' &&
            event.stream === 'stdout' &&
            event.data === 'java_stdin=from-stdin\n'
      ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'output' &&
            event.stream === 'stdout' &&
            event.data === 'proc-info\n'
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'output' &&
            event.stream === 'stdout' &&
            event.data === 'proc-stream=tracekernel test\n'
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'output' &&
            event.stream === 'stdout' &&
            event.data === 'proc-write:IOException\n'
      ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'output' &&
            event.stream === 'stdout' &&
            event.data === 'dev_stdin=from-stdin\n'
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'output' &&
            event.stream === 'stdout' &&
            event.data === 'dev_stream_stdin=from-stdin\n'
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'output' &&
            event.stream === 'stdout' &&
            event.data === 'dev_nio_stream_stdin=from-stdin\n'
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'output' &&
            event.stream === 'stdout' &&
            event.data === 'dev_nio_reader_stdin=from-stdin\n'
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'output' &&
            event.stream === 'stdout' &&
            event.data === 'dev_read_all_lines=from-stdin\n'
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'output' &&
            event.stream === 'stdout' &&
            event.data === 'dev_lines=from-stdin\n'
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'output' &&
            event.stream === 'stdout' &&
            event.data === 'dev_channel_stdin=from-stdin\n'
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'output' &&
            event.stream === 'stdout' &&
            event.data === 'dev_stream_custom=from-stdin\n'
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'output' &&
            event.stream === 'stdout' &&
            event.data === 'dev_stdout\n'
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'output' &&
            event.stream === 'stdout' &&
            event.data === 'fos_stdout\n'
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'output' &&
            event.stream === 'stdout' &&
            event.device === '/dev/stdout' &&
            event.data === 'fd_stdout\n' &&
            event.sourceDevice === undefined
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'output' &&
            event.stream === 'stdout' &&
            event.device === '/dev/stdout' &&
            event.data === 'fd_writer_stdout\n' &&
            event.sourceDevice === undefined
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'output' &&
            event.stream === 'stdout' &&
            event.data === 'fd_stdin=from-stdin\n'
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'output' &&
            event.stream === 'stdout' &&
            event.data === 'fd_reader_stdin=from-stdin\n'
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'output' &&
            event.stream === 'stdout' &&
            event.device === '/dev/stdout' &&
            event.data === 'dev_writer\n' &&
            event.sourceDevice === undefined
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'output' &&
            event.stream === 'stdout' &&
            event.device === '/dev/stdout' &&
            event.data === 'pw_stdout\n' &&
            event.sourceDevice === undefined
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'output' &&
            event.stream === 'stdout' &&
            event.device === '/dev/stdout' &&
            event.sourceDevice === '/dev/tty' &&
            event.data === 'fw_tty\n'
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'output' &&
            event.stream === 'stdout' &&
            event.device === '/dev/stdout' &&
            event.sourceDevice === '/dev/tty' &&
            event.data === 'dev_tty\n'
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'output' &&
            event.stream === 'stdout' &&
            event.device === '/dev/capture' &&
            event.sourceDevice === undefined &&
            event.data === 'capture-device'
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'output' &&
            event.stream === 'stdout' &&
            event.device === '/dev/stdout' &&
            event.sourceDevice === undefined &&
            event.data === 'stdout-after-capture\n'
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'output' &&
            event.stream === 'stdout' &&
            event.device === '/dev/capture' &&
            event.sourceDevice === '/dev/tee' &&
            event.data === 'tee-device'
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'output' &&
            event.stream === 'stdout' &&
            event.device === '/dev/stdout' &&
            event.sourceDevice === undefined &&
            event.data === 'stdout-after-tee\n'
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'output' &&
            event.stream === 'stdout' &&
            event.data === 'from-stdin\n'
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'output' &&
            event.stream === 'stdout' &&
            event.device === '/dev/stdout' &&
            event.data === 'bad_nested_device\n' &&
            event.sourceDevice === '/dev/nested/path'
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'output' &&
            event.stream === 'stdout' &&
            event.data === 'stdout-read:IOException\n'
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'output' &&
            event.stream === 'stderr' &&
            event.device === '/dev/stderr' &&
            event.sourceDevice === '/dev/log' &&
            event.data === 'dev_log\n'
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'output' &&
            event.stream === 'stderr' &&
            event.device === '/dev/stderr' &&
            event.sourceDevice === '/dev/log' &&
            event.data === 'pw_log\n'
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'output' &&
            event.stream === 'stderr' &&
            event.data === 'dev_stderr\n'
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'output' &&
            event.stream === 'stderr' &&
            event.device === '/dev/stderr' &&
            event.data === 'fd_stderr\n' &&
            event.sourceDevice === undefined
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'output' &&
            event.stream === 'stderr' &&
            event.data === 'ps_stderr\n'
      ) === true,
      `Java execute-project-java should emit live stdout project events: ${JSON.stringify(projectExecute.events)}`
    );
    assertCondition(
      projectExecute.events?.some(
        (event) =>
          event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change?.path === 'generated.txt' &&
          event.change.encoding === 'base64' &&
          Buffer.from(event.change.contents ?? '', 'base64').toString('utf8') === 'created\n'
      ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'file-change' &&
            event.phase === 'live' &&
            event.change?.path === 'stale.txt' &&
            event.change.deleted === true
        ) === true,
      `Java execute-project-java should emit live file-change project events: ${JSON.stringify(projectExecute.events)}`
    );
    assertCondition(
      projectExecute.events?.some(
        (event) =>
          event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change?.path === 'writer.txt' &&
          event.change.encoding === 'base64' &&
          Buffer.from(event.change.contents ?? '', 'base64').toString('utf8') === 'writer\n'
      ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'file-change' &&
            event.phase === 'live' &&
            event.change?.path === 'printed.txt' &&
            event.change.encoding === 'base64' &&
            Buffer.from(event.change.contents ?? '', 'base64').toString('utf8') === 'printed\n'
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'file-change' &&
            event.phase === 'live' &&
            event.change?.path === 'ps-file.txt' &&
            event.change.encoding === 'base64' &&
            Buffer.from(event.change.contents ?? '', 'base64').toString('utf8') === 'ps-file\n'
        ) === true,
      `Java execute-project-java should emit live writer file-change project events: ${JSON.stringify(projectExecute.events)}`
    );
    assertCondition(
      projectExecute.events?.some(
        (event) =>
          event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change?.path === 'stream.bin' &&
          event.change.encoding === 'base64' &&
          event.change.contents === Buffer.from([0, 254]).toString('base64')
      ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'file-change' &&
            event.phase === 'live' &&
            event.change?.path === 'data.bin' &&
            event.change.encoding === 'base64' &&
            event.change.contents === Buffer.from([0, 253]).toString('base64')
        ) === true,
      `Java execute-project-java should emit live binary stream file-change project events: ${JSON.stringify(projectExecute.events)}`
    );
    assertCondition(
      projectExecute.events?.some(
        (event) =>
          event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change?.path === 'nio-created.txt' &&
          event.change.encoding === 'base64' &&
          event.change.contents === ''
      ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'file-change' &&
            event.phase === 'live' &&
          event.change?.path === 'nio-stream.bin' &&
          event.change.encoding === 'base64' &&
          event.change.contents === Buffer.from([0, 252]).toString('base64')
      ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'file-change' &&
            event.phase === 'live' &&
            event.change?.path === 'nio-writer.txt' &&
            event.change.encoding === 'base64' &&
            Buffer.from(event.change.contents ?? '', 'base64').toString('utf8') === 'nio-writer\n'
        ) === true,
      `Java execute-project-java should emit live NIO stream file-change project events: ${JSON.stringify(projectExecute.events)}`
    );
    assertCondition(
      (projectExecute.events || []).filter(
        (event) =>
          event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change?.path === 'nio-created.txt' &&
          event.change.contents === ''
      ).length >= 3,
      `Java execute-project-java should emit live NIO metadata-only file-change events: ${JSON.stringify(projectExecute.events)}`
    );
    assertCondition(
      projectExecute.events?.some(
        (event) =>
          event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change?.path === 'live-dir' &&
          event.change.directory === true
      ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'file-change' &&
            event.phase === 'live' &&
            event.change?.path === 'live-dir/child' &&
            event.change.directory === true
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'file-change' &&
            event.phase === 'live' &&
            event.change?.path === 'live-dir/renamed-child' &&
            event.change.directory === true
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'file-change' &&
            event.phase === 'live' &&
            event.change?.path === 'live-dir/renamed-child' &&
            event.change.directory === true &&
            event.change.deleted === true
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'file-change' &&
            event.phase === 'live' &&
            event.change?.path === 'live-dir' &&
            event.change.directory === true &&
            event.change.deleted === true
        ) === true,
      `Java execute-project-java should emit live NIO directory mutation events: ${JSON.stringify(projectExecute.events)}`
    );
    assertCondition(
      projectExecute.events?.some(
        (event) =>
          event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change?.path === 'byte-channel.bin' &&
          event.change.encoding === 'base64' &&
          event.change.contents === 'AAcG'
      ) === true,
      `Java execute-project-java should emit live byte-channel file-change project events: ${JSON.stringify(projectExecute.events)}`
    );
    assertCondition(
      projectExecute.events?.some(
        (event) =>
          event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change?.path === 'random.bin' &&
          event.change.encoding === 'base64' &&
          event.change.contents === 'AAkI'
      ) === true,
      `Java execute-project-java should emit live random-access file-change project events: ${JSON.stringify(projectExecute.events)}`
    );
    assertCondition(
      projectExecute.events?.some(
        (event) =>
          event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change?.path === 'classic-created.txt' &&
          event.change.encoding === 'base64' &&
          event.change.contents === ''
      ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'file-change' &&
            event.phase === 'live' &&
            event.change?.path === 'classic-rename-source.txt' &&
            event.change.deleted === true
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'file-change' &&
            event.phase === 'live' &&
            event.change?.path === 'classic-renamed.txt' &&
            event.change.encoding === 'base64' &&
            Buffer.from(event.change.contents ?? '', 'base64').toString('utf8') === 'classic\n'
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'file-change' &&
            event.phase === 'live' &&
            event.change?.path === 'classic-delete.txt' &&
            event.change.deleted === true
        ) === true,
      `Java execute-project-java should emit live java.io.File mutator events: ${JSON.stringify(projectExecute.events)}`
    );
    assertCondition(
      (projectExecute.events || []).filter(
        (event) =>
          event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change?.path === 'classic-metadata.txt' &&
          event.change.contents === ''
      ).length >= 3,
      `Java execute-project-java should emit live java.io.File metadata-only file-change events: ${JSON.stringify(projectExecute.events)}`
    );
    assertCondition(
      projectExecute.events?.some(
        (event) =>
          event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change?.path === 'classic-dir' &&
          event.change.directory === true
      ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'file-change' &&
            event.phase === 'live' &&
            event.change?.path === 'classic-dir/child' &&
            event.change.directory === true
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'file-change' &&
            event.phase === 'live' &&
            event.change?.path === 'classic-dir/renamed-child' &&
            event.change.directory === true
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'file-change' &&
            event.phase === 'live' &&
            event.change?.path === 'classic-dir/renamed-child' &&
            event.change.directory === true &&
            event.change.deleted === true
        ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'file-change' &&
            event.phase === 'live' &&
            event.change?.path === 'classic-dir' &&
            event.change.directory === true &&
            event.change.deleted === true
        ) === true,
      `Java execute-project-java should emit live java.io.File directory mutation events: ${JSON.stringify(projectExecute.events)}`
    );
    assertCondition(
      projectExecute.events?.some(
        (event) =>
          event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change?.path === 'stdin-copy.txt' &&
          event.change.encoding === 'base64' &&
          Buffer.from(event.change.contents ?? '', 'base64').toString('utf8') === 'from-stdin\n'
      ) === true,
      `Java execute-project-java should emit live virtual-device copy file-change project events: ${JSON.stringify(projectExecute.events)}`
    );
    {
      const events = projectExecute.events ?? [];
      const emptyNioStreamLiveIndex = events.findIndex((event) =>
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'empty-nio-stream.bin' &&
        event.change.encoding === 'base64' &&
        event.change.contents === ''
      );
      const afterEmptyNioStreamOutputIndex = events.findIndex((event) =>
        event.type === 'output' &&
        event.stream === 'stdout' &&
        event.data === 'after-empty-nio-stream\n'
      );
      assertCondition(
        emptyNioStreamLiveIndex >= 0 && afterEmptyNioStreamOutputIndex > emptyNioStreamLiveIndex,
        `Java Files.newOutputStream open/truncate should emit live empty file-change before later stdout: ${JSON.stringify(events)}`
      );
      const liveNioWriterLiveIndex = events.findIndex((event) =>
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'nio-writer-before-output.txt' &&
        event.change.encoding === 'base64' &&
        Buffer.from(event.change.contents ?? '', 'base64').toString('utf8') === 'nio-before-output\n'
      );
      const afterLiveNioWriterOutputIndex = events.findIndex((event) =>
        event.type === 'output' &&
        event.stream === 'stdout' &&
        event.data === 'after-nio-writer-live\n'
      );
      assertCondition(
        liveNioWriterLiveIndex >= 0 && afterLiveNioWriterOutputIndex > liveNioWriterLiveIndex,
        `Java Files.newBufferedWriter writes should emit live file-change before later stdout: ${JSON.stringify(events)}`
      );
      const emptyNioWriterLiveIndex = events.findIndex((event) =>
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'empty-nio-writer.txt' &&
        event.change.encoding === 'base64' &&
        event.change.contents === ''
      );
      const afterEmptyNioWriterOutputIndex = events.findIndex((event) =>
        event.type === 'output' &&
        event.stream === 'stdout' &&
        event.data === 'after-empty-nio-writer\n'
      );
      assertCondition(
        emptyNioWriterLiveIndex >= 0 && afterEmptyNioWriterOutputIndex > emptyNioWriterLiveIndex,
        `Java Files.newBufferedWriter open/truncate should emit live empty file-change before later stdout: ${JSON.stringify(events)}`
      );
      const emptyNioChannelLiveIndex = events.findIndex((event) =>
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'empty-nio-channel.bin' &&
        event.change.encoding === 'base64' &&
        event.change.contents === ''
      );
      const afterEmptyNioChannelOutputIndex = events.findIndex((event) =>
        event.type === 'output' &&
        event.stream === 'stdout' &&
        event.data === 'after-empty-nio-channel\n'
      );
      assertCondition(
        emptyNioChannelLiveIndex >= 0 && afterEmptyNioChannelOutputIndex > emptyNioChannelLiveIndex,
        `Java Files.newByteChannel open/truncate should emit live empty file-change before later stdout: ${JSON.stringify(events)}`
      );
      const emptyWriterLiveIndex = events.findIndex((event) =>
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'empty-open-writer.txt' &&
        event.change.encoding === 'base64' &&
        event.change.contents === ''
      );
      const afterEmptyWriterOutputIndex = events.findIndex((event) =>
        event.type === 'output' &&
        event.stream === 'stdout' &&
        event.data === 'after-empty-open-writer\n'
      );
      assertCondition(
        emptyWriterLiveIndex >= 0 && afterEmptyWriterOutputIndex > emptyWriterLiveIndex,
        `Java FileWriter open/truncate should emit live empty file-change before later stdout: ${JSON.stringify(events)}`
      );
      const emptyStreamLiveIndex = events.findIndex((event) =>
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'empty-open-stream.bin' &&
        event.change.encoding === 'base64' &&
        event.change.contents === ''
      );
      const afterEmptyStreamOutputIndex = events.findIndex((event) =>
        event.type === 'output' &&
        event.stream === 'stdout' &&
        event.data === 'after-empty-open-stream\n'
      );
      assertCondition(
        emptyStreamLiveIndex >= 0 && afterEmptyStreamOutputIndex > emptyStreamLiveIndex,
        `Java FileOutputStream open/truncate should emit live empty file-change before later stdout: ${JSON.stringify(events)}`
      );
      const writerLiveIndex = events.findIndex((event) =>
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'writer-before-output.txt' &&
        event.change.encoding === 'base64' &&
        Buffer.from(event.change.contents ?? '', 'base64').toString('utf8') === 'before-output\n'
      );
      const afterWriterOutputIndex = events.findIndex((event) =>
        event.type === 'output' &&
        event.stream === 'stdout' &&
        event.data === 'after-filewriter-live\n'
      );
      assertCondition(
        writerLiveIndex >= 0 && afterWriterOutputIndex > writerLiveIndex,
        `Java FileWriter writes should emit live file-change before later stdout: ${JSON.stringify(events)}`
      );
    }
    assertCondition(
      projectExecute.files?.some((file) =>
        file.path === 'generated.txt' &&
          file.encoding === 'base64' &&
          Buffer.from(file.contents, 'base64').toString('utf8') === 'created\n'
      ) &&
        projectExecute.files?.some((file) =>
          file.path === 'writer.txt' &&
            file.encoding === 'base64' &&
            Buffer.from(file.contents, 'base64').toString('utf8') === 'writer\n'
        ) &&
        projectExecute.files?.some((file) =>
          file.path === 'printed.txt' &&
            file.encoding === 'base64' &&
            Buffer.from(file.contents, 'base64').toString('utf8') === 'printed\n'
        ) &&
        projectExecute.files?.some((file) =>
          file.path === 'ps-file.txt' &&
            file.encoding === 'base64' &&
            Buffer.from(file.contents, 'base64').toString('utf8') === 'ps-file\n'
        ) &&
        projectExecute.files?.some((file) =>
          file.path === 'stream.bin' &&
            file.encoding === 'base64' &&
            file.contents === Buffer.from([0, 254]).toString('base64')
        ) &&
        projectExecute.files?.some((file) =>
          file.path === 'data.bin' &&
            file.encoding === 'base64' &&
            file.contents === Buffer.from([0, 253]).toString('base64')
        ) &&
        projectExecute.files?.some((file) =>
          file.path === 'nio-created.txt' &&
            file.encoding === 'base64' &&
            file.contents === ''
        ) &&
        projectExecute.files?.some((file) =>
          file.path === 'nio-stream.bin' &&
            file.encoding === 'base64' &&
            file.contents === Buffer.from([0, 252]).toString('base64')
        ) &&
        projectExecute.files?.some((file) =>
          file.path === 'nio-writer.txt' &&
            file.encoding === 'base64' &&
            Buffer.from(file.contents, 'base64').toString('utf8') === 'nio-writer\n'
        ) &&
        projectExecute.files?.some((file) =>
          file.path === 'byte-channel.bin' &&
            file.encoding === 'base64' &&
            file.contents === 'AAcG'
        ) &&
        projectExecute.files?.some((file) =>
          file.path === 'random.bin' &&
            file.encoding === 'base64' &&
            file.contents === 'AAkI'
        ) &&
        projectExecute.files?.some((file) =>
          file.path === 'stdin-copy.txt' &&
            file.encoding === 'base64' &&
            Buffer.from(file.contents, 'base64').toString('utf8') === 'from-stdin\n'
        ) &&
        projectExecute.files?.some((file) =>
          file.path === 'writer-before-output.txt' &&
            file.encoding === 'base64' &&
            Buffer.from(file.contents, 'base64').toString('utf8') === 'before-output\n'
        ) &&
        projectExecute.files?.some((file) =>
          file.path === 'bytes.bin' &&
            file.encoding === 'base64' &&
            file.contents === Buffer.from([0, 255]).toString('base64')
        ) &&
        projectExecute.files?.some((file) => file.path === 'stale.txt' && file.deleted === true),
      'Java execute-project-java should return browser workspace changed files through result files'
    );
    assertCondition(
      projectExecute.events?.some(
        (event) =>
          event.type === 'file-change' &&
          event.phase === 'final-diff' &&
          event.change?.path === 'generated.txt' &&
          event.change.encoding === 'base64' &&
          Buffer.from(event.change.contents ?? '', 'base64').toString('utf8') === 'created\n'
      ) === true &&
        projectExecute.events?.some(
          (event) =>
            event.type === 'file-change' &&
            event.phase === 'final-diff' &&
            event.change?.path === 'stale.txt' &&
            event.change.deleted === true
        ) === true,
      `Java execute-project-java should emit final-diff file events: ${JSON.stringify(projectExecute.events)}`
    );
    const defaultProjectManifest = harness.projectCompileCalls.at(-1)?.sourcePaths ?? '';
    const defaultWorkspaceManifest = harness.projectCompileCalls.at(-1)?.workspaceManifest ?? '';
    const defaultManifestEntries = new Map(
      defaultProjectManifest
        .split('\n')
        .filter(Boolean)
        .map((entry) => {
          const [path, encodedSource] = entry.split('\t');
          return [path, Buffer.from(encodedSource ?? '', 'base64').toString('utf8')] as const;
        })
    );
    assertCondition(
      defaultManifestEntries.has('Helper.java') &&
        defaultManifestEntries.has('Main.java') &&
        Array.from(defaultManifestEntries.values()).some((source) => source.includes('public class Exports')),
      'Java execute-project-java should pass project files and an adapter source separately'
    );
    const defaultAdapterSource = Array.from(defaultManifestEntries.values()).find((source) => source.includes('public class Exports')) ?? '';
    assertCondition(
      defaultAdapterSource.includes('ProjectEvents.setKernelDevices("') &&
        defaultAdapterSource.includes('System.setIn(ProjectEvents.inputStream())') &&
        !defaultAdapterSource.includes('System.setIn(new java.io.ByteArrayInputStream('),
      'Java execute-project-java adapter should wire request stdin into shared ProjectEvents System.in'
    );
    assertCondition(
      defaultAdapterSource.includes('"user.dir"') &&
        defaultAdapterSource.includes('"/workspace"') &&
        defaultAdapterSource.includes('"user.home"') &&
        defaultAdapterSource.includes('"/home/user"') &&
        defaultAdapterSource.includes('"os.name"') &&
        defaultAdapterSource.includes('"tracekernel"') &&
        defaultAdapterSource.includes('java.nio.file.Path tracecodeWorkspaceRoot = java.nio.file.Paths.get(') &&
        defaultAdapterSource.includes('ProjectEvents.setProjectWorkspaceRoot(tracecodeWorkspaceRoot)'),
      'Java execute-project-java adapter should expose tracekernel system properties while retaining the internal ProjectEvents root'
    );
    assertCondition(
      defaultAdapterSource.includes('ProjectEvents.setKernelDevices("') &&
        defaultAdapterSource.includes('L2Rldi9zdGRvdXQ='),
      'Java execute-project-java adapter should pass project kernelDevices into ProjectEvents'
    );
    assertCondition(
      defaultAdapterSource.includes(Buffer.from('/dev/nested/path').toString('base64')),
      'Java execute-project-java adapter should preserve nested runtime-kernel manifest devices'
    );
    assertCondition(
      defaultAdapterSource.includes('ProjectEvents.setKernelFiles("'),
      'Java execute-project-java adapter should pass project kernelFiles into ProjectEvents'
    );
    assertCondition(
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.writeString(Path.of("generated.txt")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.readString(Path.of("/dev/stdin")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.newInputStream(Path.of("/dev/stdin")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.newBufferedReader(Path.of("/dev/stdin")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.readAllLines(Path.of("/dev/stdin")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.lines(Path.of("/dev/stdin")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.list(Path.of("/dev")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.newDirectoryStream(Path.of("/dev")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.isDirectory(Path.of("/dev")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.isRegularFile(Path.of("/dev/stdout")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.isReadable(Path.of("/dev/stdin")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.isWritable(Path.of("/dev/stdout")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.size(Path.of("/proc/kernel/info")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.exists(Path.of("/dev/stdin")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.writeString(Path.of("/dev/stdout")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('new tracecode.browser.ProjectEvents.ProjectFileWriter("writer.txt")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('new tracecode.browser.ProjectEvents.ProjectFileWriter("empty-open-writer.txt")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('new tracecode.browser.ProjectEvents.ProjectFileWriter("/dev/stdout"') === true &&
        defaultManifestEntries.get('Main.java')?.includes('new tracecode.browser.ProjectEvents.ProjectFileWriter("/dev/tty"') === true &&
        defaultManifestEntries.get('Main.java')?.includes('new tracecode.browser.ProjectEvents.ProjectPrintWriter("printed.txt")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('new tracecode.browser.ProjectEvents.ProjectPrintWriter("/dev/stdout"') === true &&
        defaultManifestEntries.get('Main.java')?.includes('new tracecode.browser.ProjectEvents.ProjectPrintWriter("/dev/log"') === true &&
        defaultManifestEntries.get('Main.java')?.includes('new tracecode.browser.ProjectEvents.ProjectFileInputStream("/dev/stdin")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('new tracecode.browser.ProjectEvents.ProjectFileReader("/dev/stdin"') === true &&
        defaultManifestEntries.get('Main.java')?.includes('new tracecode.browser.ProjectEvents.ProjectFileReader("/dev/stdout")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('new tracecode.browser.ProjectEvents.ProjectFileOutputStream("stream.bin")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('new tracecode.browser.ProjectEvents.ProjectFileOutputStream("empty-open-stream.bin")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('new tracecode.browser.ProjectEvents.ProjectFileOutputStream("/dev/stdout")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('new tracecode.browser.ProjectEvents.ProjectFileOutputStream(FileDescriptor.out)') === true &&
        defaultManifestEntries.get('Main.java')?.includes('new tracecode.browser.ProjectEvents.ProjectFileWriter(FileDescriptor.out)') === true &&
        defaultManifestEntries.get('Main.java')?.includes('new tracecode.browser.ProjectEvents.ProjectFileInputStream(FileDescriptor.in)') === true &&
        defaultManifestEntries.get('Main.java')?.includes('new tracecode.browser.ProjectEvents.ProjectFileReader(FileDescriptor.in)') === true &&
        defaultManifestEntries.get('Main.java')?.includes('new tracecode.browser.ProjectEvents.ProjectFileOutputStream(FileDescriptor.err)') === true &&
        defaultManifestEntries.get('Main.java')?.includes('new tracecode.browser.ProjectEvents.ProjectPrintStream("/dev/stderr"') === true &&
        defaultManifestEntries.get('Main.java')?.includes('new tracecode.browser.ProjectEvents.ProjectFile("classic-created.txt")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('new DataOutputStream(new tracecode.browser.ProjectEvents.ProjectFileOutputStream("data.bin")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.newByteChannel(Path.of("byte-channel.bin")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('new tracecode.browser.ProjectEvents.ProjectRandomAccessFile("random.bin", "rw")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.copy(Path.of("/dev/stdin"), Path.of("stdin-copy.txt")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.copy(Path.of("stdin-copy.txt"), Path.of("/dev/stdout")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.createFile(Path.of("nio-created.txt")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.setLastModifiedTime(Path.of("nio-created.txt")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.setAttribute(Path.of("nio-created.txt")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.createDirectories(Path.of("live-dir/child")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.createTempFile(tempRoot, "case", ".txt")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.createTempDirectory(tempRoot, "child")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.move(Path.of("live-dir/child"), Path.of("live-dir/renamed-child")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.delete(Path.of("live-dir/renamed-child")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.newOutputStream(Path.of("nio-stream.bin")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.newBufferedWriter(Path.of("nio-writer.txt")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.newOutputStream(Path.of("empty-nio-stream.bin")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.newBufferedWriter(Path.of("empty-nio-writer.txt")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.newByteChannel(Path.of("empty-nio-channel.bin")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.deleteIfExists(Path.of("stale.txt")') === true,
      'Java execute-project-java should route project source file mutations through the live event bridge'
    );
    assertCondition(
        defaultWorkspaceManifest.includes('Helper.java') &&
        defaultWorkspaceManifest.includes('Main.java') &&
        defaultWorkspaceManifest.includes('/proc/kernel/info\t') &&
        defaultWorkspaceManifest.includes('/proc/kernel/version\t') &&
        defaultWorkspaceManifest.includes('/proc/self/mountinfo\t') &&
        defaultWorkspaceManifest.includes('/tracekernel/custom\t') &&
        defaultWorkspaceManifest.includes('\tdir\tempty/child') &&
        harness.projectCompileCalls.at(-1)?.workspaceRoot?.endsWith('/workspace') &&
        harness.projectCompileCalls.at(-1)?.workspaceCwd?.endsWith('/workspace'),
      'Java execute-project-java should pass full project workspace files to the browser helper'
    );
    console.log('PASS: java worker executes project requests through a multifile compile path');

    harness.httpDispatches.length = 0;
    const javaHttpTimeoutExecute = await harness.sendMessage<{ stdout: string; stderr: string; exitCode: number }>('execute-project-java', {
      code: '',
      source: 'run',
      scriptPath: 'Main',
      args: [],
      cwd: '/workspace',
      env: {},
      project: {
        files: [
          {
            path: 'Main.java',
            contents: [
              'class Main {',
              '  static final String PROBE = "TRACEKERNEL_HTTP_TIMEOUT_BRIDGE_PROBE";',
              '  public static void main(String[] args) {}',
              '}',
              '',
            ].join('\n'),
          },
        ],
      },
    });
    assertCondition(javaHttpTimeoutExecute.exitCode === 0, 'Java execute-project-java HTTP timeout bridge probe should succeed');
    assertCondition(
      javaHttpTimeoutExecute.stdout === 'java-http-ok\n',
      `Java execute-project-java should receive HTTP bridge responses: ${JSON.stringify(javaHttpTimeoutExecute)}`
    );
    const javaHttpDispatch = harness.httpDispatches.at(-1);
    assertCondition(
      harness.httpDispatches.length === 1 &&
        javaHttpDispatch?.timeoutMs === 4567 &&
        javaHttpDispatch.request.path === '/java-timeout',
      `Java execute-project-java should forward HTTP timeoutMs through the sync bridge: ${JSON.stringify(harness.httpDispatches)}`
    );
    console.log('PASS: java worker forwards HTTP timeoutMs through the sync bridge');

    const runtimeFailureProjectExecute = await harness.sendMessage<{ stdout: string; stderr: string; exitCode: number; events?: Array<{ type: string; stream?: string; data?: string }> }>('execute-project-java', {
      code: '',
      source: 'run',
      scriptPath: 'Main',
      args: [],
      cwd: '/workspace',
      env: {},
      project: {
        files: [
          {
            path: 'Main.java',
            contents: [
              'class Main {',
              '  static void inner() { throw new RuntimeException("boom-java-stack"); }',
              '  public static void main(String[] args) { inner(); }',
              '}',
              '',
            ].join('\n'),
          },
        ],
      },
    });
    const runtimeFailureStderr = [
      runtimeFailureProjectExecute.stderr,
      ...(runtimeFailureProjectExecute.events ?? [])
        .filter((event) => event.type === 'output' && event.stream === 'stderr')
        .map((event) => event.data ?? ''),
    ].join('\n');
    assertCondition(runtimeFailureProjectExecute.exitCode === 1, 'Java execute-project-java should return runtime failure exit codes');
    assertCondition(
      runtimeFailureProjectExecute.stderr.includes('RuntimeException: boom-java-stack') &&
        runtimeFailureProjectExecute.stderr.includes('at Main.inner') &&
        runtimeFailureProjectExecute.stderr.includes('at Main.main') &&
        runtimeFailureProjectExecute.stderr.includes('java.lang.reflect.Method.invoke'),
      `Java execute-project-java should preserve user runtime stack frames: ${runtimeFailureProjectExecute.stderr}`
    );
    assertCondition(
      !runtimeFailureStderr.includes('tracecode.browser') &&
        !runtimeFailureStderr.includes('CheerpJLibrary'),
      `Java execute-project-java should not leak harness stack frames through stderr/events: ${runtimeFailureStderr}`
    );
    console.log('PASS: java worker sanitizes browser project runtime stack traces');

    const transitiveJavacProjectExecute = await harness.sendMessage<{ stdout: string; stderr: string; exitCode: number }>('execute-project-java', {
      code: '',
      source: 'compile',
      scriptPath: 'Main.java',
      args: ['Main.java'],
      cwd: '/workspace',
      env: {},
      project: {
        files: [
          {
            path: 'Main.java',
            contents: 'class Main { public static void main(String[] args) { System.out.println(Helper.value()); } }\n',
          },
          {
            path: 'Helper.java',
            contents: 'class Helper { static int value() { return 5; } }\n',
          },
        ],
      },
    });
    assertCondition(
      transitiveJavacProjectExecute.exitCode === 0,
      `Java execute-project-java should compile javac Main.java with referenced project sources: ${transitiveJavacProjectExecute.stderr}`
    );
    const transitiveJavacManifest = harness.projectCompileCalls.at(-1)?.sourcePaths ?? '';
    assertCondition(
      transitiveJavacManifest.includes('Main.java') && transitiveJavacManifest.includes('Helper.java'),
      `Java execute-project-java should include transitive helper sources for javac Main.java: ${transitiveJavacManifest}`
    );
    console.log('PASS: java worker includes referenced project sources for javac Main.java');

    await harness.sendMessage<{ stdout: string; stderr: string; exitCode: number }>('execute-project-java', {
      code: '',
      source: 'run',
      scriptPath: 'Main',
      args: [],
      cwd: '/workspace/src',
      env: {},
      project: {
        cwd: '/workspace',
        files: [
          { path: 'src/Main.java', contents: 'public class Main { public static void main(String[] args) {} }\n' },
        ],
      },
    });
    assertCondition(
      harness.projectCompileCalls.at(-1)?.workspaceRoot?.endsWith('/workspace') &&
        harness.projectCompileCalls.at(-1)?.workspaceCwd?.endsWith('/workspace/src'),
      'Java execute-project-java should pass request cwd separately from workspace root'
    );
    console.log('PASS: java worker preserves project cwd for browser workspace runs');

    const systemPropertyProjectExecute = await harness.sendMessage<{ stdout: string; stderr: string; exitCode: number }>('execute-project-java', {
      code: '',
      source: 'run',
      scriptPath: 'PropMain',
      args: [],
      cwd: '/workspace',
      env: {},
      options: { systemProperties: { 'trace.mode': 'browser', 'empty.value': '' } },
      project: {
        files: [
          {
            path: 'PropMain.java',
            contents: [
              'public class PropMain {',
              '  public static void main(String[] args) {',
              '    System.out.println(System.getProperty("trace.mode", "missing"));',
              '    System.out.println(System.getProperty("empty.value", "missing"));',
              '  }',
              '}',
              '',
            ].join('\n'),
          },
        ],
      },
    });
    assertCondition(systemPropertyProjectExecute.exitCode === 0, 'Java execute-project-java should accept system properties');
    const systemPropertyManifest = harness.projectCompileCalls.at(-1)?.sourcePaths ?? '';
    const systemPropertyAdapterSource = Array.from(
      new Map(
        systemPropertyManifest
          .split('\n')
          .filter(Boolean)
          .map((entry) => {
            const [path, encodedSource] = entry.split('\t');
            return [path, Buffer.from(encodedSource ?? '', 'base64').toString('utf8')] as const;
          })
      ).values()
    ).find((source) => source.includes('"trace.mode"') && source.includes('"browser"'));
    assertCondition(
      systemPropertyAdapterSource?.includes('"empty.value"') === true &&
        systemPropertyAdapterSource.includes('System.setProperty(propertyKeys[index], propertyValues[index])') &&
        systemPropertyAdapterSource.includes('System.clearProperty(key)'),
      'Java execute-project-java should set and restore -D system properties in the browser adapter'
    );
    console.log('PASS: java worker applies browser project system properties without changing the project API');

    const jarProjectExecute = await harness.sendMessage<{ stdout: string; stderr: string; exitCode: number }>('execute-project-java', {
      code: '',
      source: 'run',
      scriptPath: 'app.jar',
      args: ['alpha', 'beta'],
      cwd: '/workspace',
      env: {},
      options: { jarPath: 'app.jar', classpath: 'app.jar', jarMainClass: 'app.Main', systemProperties: { 'trace.mode': 'jar' } },
      project: {
        files: [
          { path: 'app.jar', contents: 'UEsDBAo=', encoding: 'base64' },
        ],
      },
    });
    assertCondition(jarProjectExecute.exitCode === 0, 'Java execute-project-java should accept jar execution options');
    const jarClassCall = harness.projectClassCompileCalls.at(-1);
    const jarAdapterSource = Array.from(
      new Map(
        (jarClassCall ? harness.stringFiles.at(-1)?.source ?? '' : '')
          .split('\n')
          .filter(Boolean)
          .map((line) => [line, line] as const)
      ).values()
    ).join('\n');
    assertCondition(
      jarClassCall?.classManifest.includes('app.jar') &&
        jarClassCall.runtimeClasspath.includes('/classpath/app.jar') &&
        jarClassCall.workspaceManifest?.includes('app.jar') &&
        jarClassCall.mainClassName.startsWith('Exports'),
      'Java execute-project-java should run -jar requests from the persisted jar classpath'
    );
    assertCondition(
      harness.projectClassCompileCalls.length > 0,
      `Java execute-project-java should route jar execution through classpath project mode: ${jarAdapterSource}`
    );
    console.log('PASS: java worker routes browser jar execution through persisted project jar resources');

    const packagedProjectExecute = await harness.sendMessage<{ stdout: string; stderr: string; exitCode: number }>('execute-project-java', {
      code: '',
      source: 'run',
      scriptPath: 'app.Main',
      args: ['alpha', 'beta'],
      cwd: '/workspace',
      env: {},
      project: {
        files: [
          { path: 'src/app/Helper.java', contents: 'package app;\nclass Helper { static int add(int a, int b) { return a + b; } }\n' },
          {
            path: 'src/app/Main.java',
            contents: [
              'package app;',
              'public class Main {',
              '  public static void main(String[] args) {',
              '    System.out.println(Helper.add(2, 3));',
              '    System.out.println("java_args=" + String.join(",", args));',
              '  }',
              '}',
              '',
            ].join('\n'),
          },
        ],
      },
    });
    assertCondition(packagedProjectExecute.exitCode === 0, 'Java execute-project-java should accept packaged main classes');
    const latestProjectManifest = harness.projectCompileCalls.at(-1)?.sourcePaths ?? '';
    const manifestEntries = new Map(
      latestProjectManifest
        .split('\n')
        .filter(Boolean)
        .map((entry) => {
          const [path, encodedSource] = entry.split('\t');
          return [path, Buffer.from(encodedSource ?? '', 'base64').toString('utf8')] as const;
        })
    );
    assertCondition(
      manifestEntries.get('src/app/Main.java')?.includes('package app;') &&
        manifestEntries.get('src/app/Helper.java')?.includes('package app;'),
      'Java execute-project-java should preserve packaged project paths in the source manifest'
    );
    assertCondition(
      harness.projectCompileCalls.at(-1)?.mainClassName.startsWith('Exports') &&
        Array.from(manifestEntries.values()).some((source) => source.includes('app.Main.main(new String[] { "alpha", "beta" });')),
      'Java execute-project-java should compile packaged project files through the multifile helper'
    );
    console.log('PASS: java worker executes packaged project requests through the shared project path');

    const jarCompileProjectExecute = await harness.sendMessage<{ stdout: string; stderr: string; exitCode: number }>('execute-project-java', {
      code: '',
      source: 'compile',
      scriptPath: 'src/app/Main.java',
      args: ['@javac.args'],
      cwd: '/workspace',
      env: {},
      project: {
        files: [
          {
            path: 'javac.args',
            contents: [
              '-cp lib/external.jar',
              '-d out',
              '-encoding UTF-8',
              '-sourcepath src',
              '-s generated/NotSource.java',
              '-h headers/NotSource.java',
              '--module-path lib/external.jar',
              '-processorpath lib/external.jar',
              'src/app/Main.java',
              '',
            ].join('\n'),
          },
          {
            path: 'src/app/Main.java',
            contents: 'package app;\nimport lib.External;\npublic class Main { public static void main(String[] args) { System.out.println(External.value()); } }\n',
          },
          { path: 'src/app/Broken.java', contents: 'package app;\nclass Broken { syntax error }\n' },
          { path: 'lib/external.jar', contents: 'UEsDBAo=', encoding: 'base64' },
        ],
      },
    });
    assertCondition(jarCompileProjectExecute.exitCode === 0, 'Java execute-project-java should accept javac classpath jar resources');
    const jarCompileCall = harness.projectCompileCalls.at(-1);
    assertCondition(
      jarCompileCall?.resourceManifest?.includes('lib/external.jar') &&
        jarCompileCall.compileClasspath?.includes('/classpath/lib/external.jar') &&
        jarCompileCall.compileSourcePaths === 'src/app/Main.java' &&
        jarCompileCall.compileSourceRootPaths === 'src' &&
        jarCompileCall.sourcePaths.includes('src/app/Broken.java') &&
        !jarCompileCall.sourcePaths.includes('Exports'),
      'Java execute-project-java should materialize jar resources before browser javac classpath compile'
    );
    console.log('PASS: java worker compiles project sources against persisted jar resources');

    const verboseJavacProjectExecute = await harness.sendMessage<{ stdout: string; stderr: string; exitCode: number }>('execute-project-java', {
      code: '',
      source: 'compile',
      scriptPath: 'src/app/Main.java',
      args: ['-verbose', '-d', 'out', '-sourcepath', 'src', 'src/app/Main.java'],
      cwd: '/workspace',
      env: {},
      project: {
        files: [
          {
            path: 'src/app/Main.java',
            contents: 'package app;\npublic class Main { public static void main(String[] args) {} }\n',
          },
        ],
      },
    });
    assertCondition(verboseJavacProjectExecute.exitCode === 0, 'Java execute-project-java should compile with -verbose');
    assertCondition(
      verboseJavacProjectExecute.stderr.includes('[search path for source files: src]') &&
        verboseJavacProjectExecute.stderr.includes('[wrote /workspace/out/src/app/Main.class]'),
      `Java execute-project-java should surface javac -verbose output, received ${JSON.stringify(verboseJavacProjectExecute.stderr)}`
    );
    console.log('PASS: java worker surfaces javac -verbose output for browser project compile');

    const cwdRelativeJarCompileProjectExecute = await harness.sendMessage<{ stdout: string; stderr: string; exitCode: number; files?: Array<{ path: string; contents?: string; encoding?: string }> }>('execute-project-java', {
      code: '',
      source: 'compile',
      scriptPath: '../src/app/Main.java',
      args: ['-cp', '../lib/external.jar', '-d', '../rel-out', '-sourcepath', '../src', '../src/app/Main.java'],
      cwd: '/workspace/build',
      env: {},
      project: {
        cwd: '/workspace',
        files: [
          { path: 'build/.keep', contents: '' },
          {
            path: 'src/app/Main.java',
            contents: 'package app;\nimport lib.External;\npublic class Main { public static void main(String[] args) { System.out.println(External.value()); } }\n',
          },
          { path: 'lib/external.jar', contents: 'UEsDBAo=', encoding: 'base64' },
        ],
      },
    });
    assertCondition(cwdRelativeJarCompileProjectExecute.exitCode === 0, 'Java execute-project-java should accept cwd-relative javac resources');
    const cwdRelativeJarCompileCall = harness.projectCompileCalls.at(-1);
    assertCondition(
      cwdRelativeJarCompileCall?.resourceManifest?.includes('lib/external.jar') &&
        cwdRelativeJarCompileCall.compileClasspath?.includes('/classpath/lib/external.jar') &&
        cwdRelativeJarCompileCall.compileSourcePaths === 'src/app/Main.java' &&
        cwdRelativeJarCompileCall.compileSourceRootPaths === 'src' &&
        cwdRelativeJarCompileProjectExecute.files?.some((file) => file.path === 'rel-out/app/Main.class'),
      'Java execute-project-java should normalize cwd-relative javac paths inside the browser workspace'
    );
    console.log('PASS: java worker resolves cwd-relative javac source, output, sourcepath, and classpath paths');

    const canonicalRootCompileProjectExecute = await harness.sendMessage<{ stdout: string; stderr: string; exitCode: number; files?: Array<{ path: string; contents?: string; encoding?: string }> }>('execute-project-java', {
      code: '',
      source: 'compile',
      scriptPath: '/home/ada/weather-api/src/app/Main.java',
      args: [
        '-cp',
        '/home/ada/weather-api/lib/external.jar',
        '-d',
        '/home/ada/weather-api/out',
        '-sourcepath',
        '/home/ada/weather-api/src',
        '/home/ada/weather-api/src/app/Main.java',
      ],
      cwd: '/home/ada/weather-api/src',
      env: {},
      project: {
        cwd: '/home/ada/weather-api',
        workspaceRoot: '/home/ada/weather-api',
        workspaceAlias: '/workspace',
        files: [
          {
            path: 'src/app/Main.java',
            contents: 'package app;\nimport lib.External;\npublic class Main { public static void main(String[] args) { System.out.println(External.value()); } }\n',
          },
          { path: 'lib/external.jar', contents: 'UEsDBAo=', encoding: 'base64' },
        ],
      },
    });
    assertCondition(canonicalRootCompileProjectExecute.exitCode === 0, 'Java execute-project-java should accept canonical /home javac paths');
    const canonicalRootCompileCall = harness.projectCompileCalls.at(-1);
    assertCondition(
      canonicalRootCompileCall?.resourceManifest?.includes('lib/external.jar') &&
        canonicalRootCompileCall.compileClasspath?.includes('/classpath/lib/external.jar') &&
        canonicalRootCompileCall.compileSourcePaths === 'src/app/Main.java' &&
        canonicalRootCompileCall.compileSourceRootPaths === 'src' &&
        canonicalRootCompileProjectExecute.files?.some((file) => file.path === 'out/app/Main.class'),
      'Java execute-project-java should normalize canonical /home javac paths inside the browser workspace'
    );
    console.log('PASS: java worker resolves canonical /home javac source, output, sourcepath, and classpath paths');

    const envClasspathCompileProjectExecute = await harness.sendMessage<{ stdout: string; stderr: string; exitCode: number }>('execute-project-java', {
      code: '',
      source: 'compile',
      scriptPath: 'src/app/Main.java',
      args: ['-d', 'out', 'src/app/Main.java'],
      cwd: '/workspace',
      env: { CLASSPATH: '/workspace/lib/external.jar' },
      project: {
        files: [
          {
            path: 'src/app/Main.java',
            contents: 'package app;\nimport lib.External;\npublic class Main { public static void main(String[] args) { System.out.println(External.value()); } }\n',
          },
          { path: 'lib/external.jar', contents: 'UEsDBAo=', encoding: 'base64' },
        ],
      },
    });
    assertCondition(envClasspathCompileProjectExecute.exitCode === 0, 'Java execute-project-java should accept javac CLASSPATH jar resources');
    const envClasspathCompileCall = harness.projectCompileCalls.at(-1);
    assertCondition(
      envClasspathCompileCall?.resourceManifest?.includes('lib/external.jar') &&
        envClasspathCompileCall.compileClasspath?.includes('/classpath/lib/external.jar') &&
        envClasspathCompileCall.compileSourcePaths === 'src/app/Main.java',
      'Java execute-project-java should materialize CLASSPATH jar resources for browser javac'
    );
    console.log('PASS: java worker compiles project sources against env CLASSPATH resources');

    const outsideCompileClasspathExecute = await harness.sendMessage<{ stdout: string; stderr: string; exitCode: number }>('execute-project-java', {
      code: '',
      source: 'compile',
      scriptPath: 'src/app/Main.java',
      args: ['-d', 'out', '-cp', '/outside/lib/external.jar', 'src/app/Main.java'],
      cwd: '/workspace',
      env: {},
      project: {
        files: [
          {
            path: 'src/app/Main.java',
            contents: 'package app;\npublic class Main { public static void main(String[] args) {} }\n',
          },
        ],
      },
    });
    assertCondition(
      outsideCompileClasspathExecute.exitCode !== 0 &&
        outsideCompileClasspathExecute.stderr.includes('Project path must stay within the workspace: /outside/lib/external.jar'),
      `Java execute-project-java should reject javac classpath entries outside the workspace: ${outsideCompileClasspathExecute.stderr}`
    );

    const relativeOutsideCompileClasspathExecute = await harness.sendMessage<{ stdout: string; stderr: string; exitCode: number }>('execute-project-java', {
      code: '',
      source: 'compile',
      scriptPath: 'src/app/Main.java',
      args: ['-d', 'out', '-cp', '../outside/lib/external.jar', 'src/app/Main.java'],
      cwd: '/workspace',
      env: {},
      project: {
        files: [
          {
            path: 'src/app/Main.java',
            contents: 'package app;\npublic class Main { public static void main(String[] args) {} }\n',
          },
        ],
      },
    });
    assertCondition(
      relativeOutsideCompileClasspathExecute.exitCode !== 0 &&
        relativeOutsideCompileClasspathExecute.stderr.includes('Project path must not escape the workspace: ../outside/lib/external.jar'),
      `Java execute-project-java should reject cwd-relative javac classpath escapes: ${relativeOutsideCompileClasspathExecute.stderr}`
    );

    const previewCompileCallCount = harness.projectCompileCalls.length;
    const previewCompileProjectExecute = await harness.sendMessage<{ stdout: string; stderr: string; exitCode: number }>('execute-project-java', {
      code: '',
      source: 'compile',
      scriptPath: 'Main.java',
      args: ['--enable-preview', 'Main.java'],
      cwd: '/workspace',
      env: {},
      project: {
        files: [
          {
            path: 'Main.java',
            contents: 'class Main { public static void main(String[] args) {} }\n',
          },
        ],
      },
    });
    assertCondition(
      previewCompileProjectExecute.exitCode !== 0 &&
        previewCompileProjectExecute.stderr.includes('--enable-preview is not supported in the browser project environment'),
      `Java execute-project-java should explicitly reject browser javac preview mode: ${previewCompileProjectExecute.stderr}`
    );
    assertCondition(
      harness.projectCompileCalls.length === previewCompileCallCount,
      'Java execute-project-java should reject unsupported browser javac flags before invoking the compile helper'
    );
    const previewRunCallCount = harness.projectCompileCalls.length;
    const previewRunProjectExecute = await harness.sendMessage<{ stdout: string; stderr: string; exitCode: number }>('execute-project-java', {
      code: '',
      source: 'run',
      scriptPath: 'Main',
      args: [],
      cwd: '/workspace',
      env: {},
      options: { enablePreview: true },
      project: {
        files: [
          {
            path: 'Main.java',
            contents: 'class Main { public static void main(String[] args) {} }\n',
          },
        ],
      },
    });
    assertCondition(
      previewRunProjectExecute.exitCode !== 0 &&
        previewRunProjectExecute.stderr.includes('--enable-preview is not supported in the browser project environment'),
      `Java execute-project-java should explicitly reject browser java preview mode: ${previewRunProjectExecute.stderr}`
    );
    assertCondition(
      harness.projectCompileCalls.length === previewRunCallCount,
      'Java execute-project-java should reject unsupported browser java preview mode before invoking the compile helper'
    );

    const duplicateBasenameProjectExecute = await harness.sendMessage<{ stdout: string; stderr: string; exitCode: number }>('execute-project-java', {
      code: '',
      source: 'run',
      scriptPath: 'b.Main',
      args: [],
      cwd: '/workspace',
      env: {},
      project: {
        files: [
          {
            path: 'src/a/Main.java',
            contents: 'package a;\npublic class Main { public static int value() { return 5; } }\n',
          },
          {
            path: 'src/b/Main.java',
            contents: 'package b;\npublic class Main { public static void main(String[] args) { System.out.println(a.Main.value()); } }\n',
          },
        ],
      },
    });
    assertCondition(duplicateBasenameProjectExecute.exitCode === 0, 'Java execute-project-java should accept duplicate basenames in different packages');
    const duplicateBasenameManifest = harness.projectCompileCalls.at(-1)?.sourcePaths ?? '';
    assertCondition(
      duplicateBasenameManifest.includes('src/a/Main.java') &&
        duplicateBasenameManifest.includes('src/b/Main.java'),
      'Java execute-project-java should keep duplicate basenames distinct by project path'
    );
    console.log('PASS: java worker preserves duplicate Java basenames across packages');

    const classpathProjectExecute = await harness.sendMessage<{ stdout: string; stderr: string; exitCode: number }>('execute-project-java', {
      code: '',
      source: 'run',
      scriptPath: 'app.Main',
      args: ['alpha', 'beta'],
      cwd: '/workspace',
      env: {},
      options: { classpath: 'out' },
      project: {
        files: [
          { path: 'out/app/Main.class', contents: 'yv66vg==', encoding: 'base64' },
          { path: 'out/app/Helper.class', contents: 'yv66vg==', encoding: 'base64' },
          { path: 'lib/external.jar', contents: 'UEsDBAo=', encoding: 'base64' },
          { path: 'src/app/Main.java', contents: 'package app;\npublic class Main {}\n' },
        ],
      },
    });
    assertCondition(classpathProjectExecute.exitCode === 0, 'Java execute-project-java should run explicit classpath class files');
    const classpathCall = harness.projectClassCompileCalls.at(-1);
    assertCondition(
      classpathCall?.classManifest.includes('out/app/Main.class') &&
        classpathCall.classManifest.includes('lib/external.jar') &&
        !classpathCall.classManifest.includes('src/app/Main.java') &&
        classpathCall.runtimeClasspath.includes('/classpath/out') &&
        classpathCall.workspaceManifest?.includes('src/app/Main.java') &&
        classpathCall.workspaceRoot?.endsWith('/workspace'),
      'Java execute-project-java should use persisted class files for explicit classpath runs'
    );
    const classpathAdapterSource = Buffer.from(
      classpathCall?.sourceManifest?.split('\t')[1]?.trim() ?? '',
      'base64'
    ).toString('utf8');
    assertCondition(
      classpathAdapterSource.includes('Class.forName("app.Main")') &&
        classpathAdapterSource.includes('getMethod("main", String[].class)') &&
        classpathAdapterSource.includes('__tracecodeMain.invoke(null, (Object) new String[] { "alpha", "beta" });') &&
        !classpathAdapterSource.includes('app.Main.main('),
      `Java execute-project-java should invoke explicit classpath main classes reflectively: ${classpathAdapterSource}`
    );
    console.log('PASS: java worker runs explicit project classpath requests from persisted class files');

    const defaultPackageCompileProjectExecute = await harness.sendMessage<{ stdout: string; stderr: string; exitCode: number; files?: Array<{ path: string; contents?: string; encoding?: string }> }>('execute-project-java', {
      code: '',
      source: 'compile',
      scriptPath: 'java/TicketTriage.java',
      args: ['java/TicketTriage.java'],
      cwd: '/workspace',
      env: {},
      project: {
        files: [
          { path: 'java/TicketTriage.java', contents: 'public class TicketTriage { public static void main(String[] args) {} }\n' },
        ],
      },
    });
    assertCondition(defaultPackageCompileProjectExecute.exitCode === 0, 'Java execute-project-java should compile source-directory default-package classes');
    assertCondition(
      defaultPackageCompileProjectExecute.files?.some((file) => file.path === 'java/TicketTriage.class' && file.encoding === 'base64') === true,
      `Java execute-project-java should persist no--d default-package class files next to source: ${JSON.stringify(defaultPackageCompileProjectExecute.files)}`
    );
    console.log('PASS: java worker persists no--d default-package class files next to source');

    const defaultPackageClasspathProjectExecute = await harness.sendMessage<{ stdout: string; stderr: string; exitCode: number }>('execute-project-java', {
      code: '',
      source: 'run',
      scriptPath: 'TicketTriage',
      args: [],
      cwd: '/workspace',
      env: {},
      stdinPipe: createRuntimeCommandStdinPipeFromText('Acme\n5\n'),
      options: { classpath: 'java' },
      project: {
        files: [
          { path: 'java/TicketTriage.class', contents: 'yv66vg==', encoding: 'base64' },
          { path: 'java/TicketTriage.java', contents: 'public class TicketTriage { public static void main(String[] args) {} }\n' },
        ],
      },
    });
    assertCondition(defaultPackageClasspathProjectExecute.exitCode === 0, 'Java execute-project-java should run default-package classpath class files');
    const defaultPackageClasspathCall = harness.projectClassCompileCalls.at(-1);
    const defaultPackageAdapterSource = Buffer.from(
      defaultPackageClasspathCall?.sourceManifest?.split('\t')[1]?.trim() ?? '',
      'base64'
    ).toString('utf8');
    assertCondition(
      defaultPackageClasspathCall?.classManifest.includes('java/TicketTriage.class') &&
        defaultPackageClasspathCall.runtimeClasspath.includes('/classpath/java') &&
        defaultPackageClasspathCall.workspaceManifest?.includes('java/TicketTriage.java') &&
        defaultPackageAdapterSource.includes('Class.forName("TicketTriage")') &&
        !defaultPackageAdapterSource.includes('TicketTriage.main('),
      `Java execute-project-java should invoke default-package classpath main classes reflectively: ${JSON.stringify({
        defaultPackageClasspathCall,
        defaultPackageAdapterSource,
      })}`
    );
    console.log('PASS: java worker runs default-package project classpath requests reflectively');

    const envClasspathProjectExecute = await harness.sendMessage<{ stdout: string; stderr: string; exitCode: number }>('execute-project-java', {
      code: '',
      source: 'run',
      scriptPath: 'app.Main',
      args: ['gamma'],
      cwd: '/workspace',
      env: { CLASSPATH: '/workspace/out' },
      project: {
        files: [
          { path: 'out/app/Main.class', contents: 'yv66vg==', encoding: 'base64' },
          { path: 'out/app/Helper.class', contents: 'yv66vg==', encoding: 'base64' },
          { path: 'src/app/Main.java', contents: 'package app;\npublic class Main {}\n' },
        ],
      },
    });
    assertCondition(envClasspathProjectExecute.exitCode === 0, 'Java execute-project-java should run env CLASSPATH class files');
    const envClasspathCall = harness.projectClassCompileCalls.at(-1);
    assertCondition(
      envClasspathCall?.classManifest.includes('out/app/Main.class') &&
        !envClasspathCall.classManifest.includes('src/app/Main.java') &&
        envClasspathCall.runtimeClasspath.includes('/classpath/out') &&
        envClasspathCall.workspaceManifest?.includes('src/app/Main.java'),
      'Java execute-project-java should use persisted class files for env CLASSPATH runs'
    );
    console.log('PASS: java worker runs project classpath requests from env CLASSPATH');

    const cwdRelativeClasspathProjectExecute = await harness.sendMessage<{ stdout: string; stderr: string; exitCode: number }>('execute-project-java', {
      code: '',
      source: 'run',
      scriptPath: 'app.Main',
      args: ['delta'],
      cwd: '/workspace/build',
      env: { CLASSPATH: '../out:../lib/external.jar' },
      project: {
        cwd: '/workspace',
        files: [
          { path: 'build/.keep', contents: '' },
          { path: 'out/app/Main.class', contents: 'yv66vg==', encoding: 'base64' },
          { path: 'lib/external.jar', contents: 'UEsDBAo=', encoding: 'base64' },
          { path: 'src/app/Main.java', contents: 'package app;\npublic class Main {}\n' },
        ],
      },
    });
    assertCondition(cwdRelativeClasspathProjectExecute.exitCode === 0, 'Java execute-project-java should run cwd-relative env CLASSPATH class files');
    const cwdRelativeClasspathCall = harness.projectClassCompileCalls.at(-1);
    assertCondition(
      cwdRelativeClasspathCall?.runtimeClasspath.includes('/classpath/out') &&
        cwdRelativeClasspathCall.runtimeClasspath.includes('/classpath/lib/external.jar') &&
        cwdRelativeClasspathCall.workspaceCwd?.endsWith('/workspace/build'),
      'Java execute-project-java should normalize cwd-relative runtime classpath entries inside the browser workspace'
    );
    console.log('PASS: java worker runs project classpath requests from cwd-relative env CLASSPATH');

    const outsideRunClasspathExecute = await harness.sendMessage<{ stdout: string; stderr: string; exitCode: number }>('execute-project-java', {
      code: '',
      source: 'run',
      scriptPath: 'app.Main',
      args: [],
      cwd: '/workspace',
      env: { CLASSPATH: '/outside/out' },
      project: {
        files: [
          { path: 'out/app/Main.class', contents: 'yv66vg==', encoding: 'base64' },
        ],
      },
    });
    assertCondition(
      outsideRunClasspathExecute.exitCode !== 0 &&
        outsideRunClasspathExecute.stderr.includes('Project path must stay within the workspace: /outside/out'),
      `Java execute-project-java should reject runtime CLASSPATH entries outside the workspace: ${outsideRunClasspathExecute.stderr}`
    );

    const batchExecute = await harness.sendMessage<{
      success: boolean;
      results?: Array<{ success: boolean; output: unknown }>;
    }>('execute-code-batch', {
      code: `class Solution {
  int add(int a, int b) {
    return a + b;
  }
}`,
      functionName: 'add',
      inputBatch: [
        { a: 1, b: 2 },
        { a: 3, b: 4 },
      ],
      executionStyle: 'function',
    });
    assertCondition(batchExecute.success === true, 'Java execute-code-batch should succeed');
    assertCondition(
      JSON.stringify(batchExecute.results?.map((result) => result.output)) === JSON.stringify([1, 2]),
      'Java execute-code-batch should return one output per input case'
    );
    const batchExecuteSource = latestSourceContaining(harness.stringFiles, 'class Exports');
    assertCondition(
      batchExecuteSource.includes('public class Exports') &&
        batchExecuteSource.includes('class Exports') &&
        batchExecuteSource.includes('solution.add(a, b)'),
      'Java execute-code-batch should compile one runnable source with per-case export entries'
    );

    const batchNodeExecute = await harness.sendMessage<{
      success: boolean;
      results?: Array<{ success: boolean; output: unknown }>;
      error?: string;
    }>('execute-code-batch', {
      code: `class Solution {
  int headValue(ListNode head) {
    return head == null ? -1 : head.val;
  }
}`,
      functionName: 'headValue',
      inputBatch: [
        { head: { __type__: 'ListNode', val: 1, next: { __type__: 'ListNode', val: 2, next: null } } },
        { head: { __type__: 'ListNode', val: 3, next: { __type__: 'ListNode', val: 4, next: null } } },
      ],
      executionStyle: 'function',
    });
    assertCondition(batchNodeExecute.success === true, `Java execute-code-batch with ListNode should succeed: ${JSON.stringify(batchNodeExecute)}`);
    const batchNodeSource = latestSourceContaining(harness.stringFiles, 'headValue');
    assertCondition(
      (batchNodeSource.match(/\bclass\s+ListNode\b/g) ?? []).length === 1,
      `Java execute-code-batch should emit ListNode helper classes once per batch: ${batchNodeSource}`
    );
    console.log('PASS: java execute-code-batch runs multiple non-trace cases in one worker request');

    const rewriteProbeFailure = await harness.sendMessage<{
      success: boolean;
      error?: string | null;
    }>('execute-with-tracing', {
      code: `class Solution {
  int rewriteProbeClassNotFoundRegression() {
    return 1;
  }
}`,
      functionName: 'rewriteProbeClassNotFoundRegression',
      inputs: {},
      executionStyle: 'function',
    });

    assertCondition(rewriteProbeFailure.success === false, 'Forced Java rewrite failure should surface as failed execution');
    const probeSource = harness.stringFiles.findLast((file) => file.source.includes('RewriteProbe'))?.source ?? '';
    assertCondition(
      /package harness\.user\.job.*RewriteProbe;/.test(probeSource),
      'Java rewrite diagnostic probe should compile in the probe package'
    );
    assertCondition(
      /public class Exports.*RewriteProbe/.test(probeSource),
      'Java rewrite diagnostic probe should include the synthetic probe exports class'
    );
    assertCondition(
      probeSource.includes('Solution solution = new Solution();') &&
        probeSource.includes('solution.rewriteProbeClassNotFoundRegression()'),
      'Java rewrite diagnostic probe should include the generated export invocation'
    );
    console.log('PASS: java rewrite diagnostics compile a complete probe harness');

    const scriptCode = `import java.util.HashMap;
import java.util.Map;

Map<Integer, Integer> seen = new HashMap<>();
result = new int[] { 0, 1 };`;

    const execute = await harness.sendMessage<{
      success: boolean;
      output: unknown;
      events?: string[];
      sourceText?: string;
    }>('execute-with-tracing', {
      code: scriptCode,
      functionName: '',
      inputs: {},
      executionStyle: 'function',
    });

    assertCondition(execute.success === true, 'Java script execution should succeed');
    assertCondition(JSON.stringify(execute.output) === JSON.stringify([0, 1]), 'Java script output should serialize result');
    assertCondition(execute.sourceText === scriptCode, 'Java script execution should preserve original source text');
    assertCondition(
      Array.isArray(execute.events) &&
        execute.events.some((event) => nativeEventMatches(event, { kind: 'call', function: '<module>' })),
      'Java script trace events should expose <module> call events'
    );
    assertCondition(
      Array.isArray(execute.events) &&
        execute.events.some((event) => nativeEventMatches(event, { kind: 'return', line: 5, function: '<module>' })),
      'Java script return event should remap generated wrapper line to the last user line'
    );

    const scriptRewrite = harness.rewriteCalls.at(-1);
    assertCondition(Boolean(scriptRewrite), 'Java script request should call the rewriter');
    assertCondition(scriptRewrite?.executionStyle === 'solution-method', 'Java script request should reuse solution-method rewrite path');
    assertCondition(scriptRewrite?.entryName === '__tracecodeScript', 'Java script request should use synthetic script method');
    assertCondition(
      scriptRewrite?.source.includes('Object __tracecodeScript() {') &&
        scriptRewrite.source.includes('Object result = null;'),
      'Java script source should be wrapped in a synthetic Solution method'
    );
    assertCondition(
      scriptRewrite?.source.startsWith('import java.util.HashMap;\nimport java.util.Map;'),
      'Java script source should preserve import prelude before the wrapper'
    );
    console.log('PASS: java script mode normalizes to synthetic solution method');

    const scriptWithLocalTypesCode = `import java.util.*;

class TreeNode {
  int val;
  TreeNode left;
  TreeNode right;
  TreeNode(int val) {
    this.val = val;
  }
}

class ListNode {
  int val;
  ListNode next;
  ListNode(int val) {
    this.val = val;
  }
}

class UnionFind {
  int[] parent;
  UnionFind(int n) {
    parent = new int[n];
    for (int i = 0; i < n; i++) parent[i] = i;
  }
  int find(int x) {
    if (parent[x] != x) parent[x] = find(parent[x]);
    return parent[x];
  }
}

private static int maxDepth(TreeNode root) {
  if (root == null) return 0;
  return 1 + Math.max(maxDepth(root.left), maxDepth(root.right));
}

TreeNode root = new TreeNode(3);
root.left = new TreeNode(9);
root.right = new TreeNode(20);
root.right.left = new TreeNode(15);
ListNode head = new ListNode(1);
head.next = new ListNode(2);
UnionFind uf = new UnionFind(3);
Object result = new Object[] { maxDepth(root), head.next.val, uf.find(2) };`;

    const localTypesScriptExecute = await harness.sendMessage<{
      success: boolean;
      output: unknown;
      events?: string[];
      sourceText?: string;
      error?: string | null;
    }>('execute-with-tracing', {
      code: scriptWithLocalTypesCode,
      functionName: '',
      inputs: {},
      executionStyle: 'function',
    });

    assertCondition(
      localTypesScriptExecute.success === true,
      `Java script execution with local classes should succeed: ${localTypesScriptExecute.error ?? 'unknown error'}`
    );
    assertCondition(
      JSON.stringify(localTypesScriptExecute.output) === JSON.stringify([3, 2, 2]),
      `Java script local class output should serialize result, received ${JSON.stringify(localTypesScriptExecute.output)}`
    );
    const localTypesScriptRewrite = harness.rewriteCalls.at(-1);
    assertCondition(
      Boolean(
        localTypesScriptRewrite?.source.includes('class TreeNode') &&
          localTypesScriptRewrite.source.indexOf('class TreeNode') < localTypesScriptRewrite.source.indexOf('private static int maxDepth') &&
          localTypesScriptRewrite.source.indexOf('private static int maxDepth') < localTypesScriptRewrite.source.indexOf('Object __tracecodeScript()')
      ),
      'Java script source should preserve local type declarations before helper methods and script statements'
    );
    assertCondition(
      Boolean(localTypesScriptRewrite?.exportsSource.includes('Solution solution = new Solution();')) &&
        !/\bprivate static TreeNode tree\(/.test(localTypesScriptRewrite?.exportsSource ?? '') &&
        !/\bprivate static ListNode list\(/.test(localTypesScriptRewrite?.exportsSource ?? ''),
      'Java script exports should not inject unqualified TreeNode/ListNode input materializers'
    );
    console.log('PASS: java script mode supports local classes');

    const loopCode = `class Solution {
  int uniquePaths(int rows, int cols) {
    int[][] dp = new int[rows][cols];
    for (int row = 0; row < rows; row++) dp[row][0] = 1;
    for (int col = 0; col < cols; col++) dp[0][col] = 1;
    return dp[rows - 1][cols - 1];
  }
}`;

    const loopExecute = await harness.sendMessage<{
      success: boolean;
    }>('execute-with-tracing', {
      code: loopCode,
      functionName: 'uniquePaths',
      inputs: { rows: 3, cols: 4 },
      executionStyle: 'function',
    });

    assertCondition(loopExecute.success === true, 'Java loop execution should succeed');
    const loopRewrite = harness.rewriteCalls.at(-1);
    assertCondition(
      loopRewrite?.source.includes('for (int row = 0; row < rows; row++) { dp[row][0] = 1; }'),
      'Java function source should block-wrap single-statement for loop bodies before rewrite'
    );
    assertCondition(
      loopRewrite?.source.includes('for (int col = 0; col < cols; col++) { dp[0][col] = 1; }'),
      'Java function source should block-wrap sibling single-statement for loop bodies before rewrite'
    );
    console.log('PASS: java worker block-wraps single-statement for loops before rewrite');

    const treeInputCode = `class TreeNode {
  int val;
  TreeNode left;
  TreeNode right;
  TreeNode(int val) { this.val = val; }
}

class Solution {
  int solve(TreeNode root) {
    return root == null ? 0 : root.val;
  }
}`;

    await harness.sendMessage<{ success: boolean }>('execute-with-tracing', {
      code: treeInputCode,
      functionName: 'solve',
      inputs: { root: [1, null, 2, 3] },
      executionStyle: 'function',
    });
    const treeRewrite = harness.rewriteCalls.at(-1);
    assertCondition(
      treeRewrite?.exportsSource.includes('TreeNode root = buildTree(new Integer[] { 1, null, 2, 3 });'),
      'Java worker should materialize level-order TreeNode array inputs when the signature expects TreeNode'
    );
    assertCondition(
      !treeRewrite?.exportsSource.includes('class TreeNode {'),
      'Java worker should not inject fallback TreeNode when user code declares TreeNode'
    );

    const defaultTreeInputCode = `class Solution {
  int solve(TreeNode root) {
    return root == null ? 0 : root.val + root.value;
  }
}`;

    await harness.sendMessage<{ success: boolean }>('execute-with-tracing', {
      code: defaultTreeInputCode,
      functionName: 'solve',
      inputs: { root: [4, null, 2] },
      executionStyle: 'function',
    });
    const defaultTreeRewrite = harness.rewriteCalls.at(-1);
    assertCondition(
      defaultTreeRewrite?.exportsSource.includes('class TreeNode {') &&
        defaultTreeRewrite.exportsSource.includes('int value;') &&
        defaultTreeRewrite.exportsSource.includes('this.value = val;'),
      'Java worker should inject TraceCode-compatible fallback TreeNode with val/value aliases'
    );

    const listInputCode = `class ListNode {
  int val;
  ListNode next;
  ListNode(int val) { this.val = val; }
}

class Solution {
  int solve(ListNode head) {
    return head == null ? 0 : head.val;
  }
}`;

    await harness.sendMessage<{ success: boolean }>('execute-with-tracing', {
      code: listInputCode,
      functionName: 'solve',
      inputs: { head: [1, 2, 3] },
      executionStyle: 'function',
    });
    const listRewrite = harness.rewriteCalls.at(-1);
    assertCondition(
      listRewrite?.exportsSource.includes(
        'ListNode head = buildList(new Object[] { 1, 2, 3 }, sequentialNextIndices(3));'
      ),
      'Java worker should materialize array inputs as ListNode only when the signature expects ListNode'
    );
    assertCondition(
      !listRewrite?.exportsSource.includes('class ListNode {'),
      'Java worker should not inject fallback ListNode when user code declares ListNode'
    );

    const defaultListInputCode = `class Solution {
  int solve(ListNode head) {
    return head == null ? 0 : head.val + head.value;
  }
}`;

    await harness.sendMessage<{ success: boolean }>('execute-with-tracing', {
      code: defaultListInputCode,
      functionName: 'solve',
      inputs: { head: [5, 6] },
      executionStyle: 'function',
    });
    const defaultListRewrite = harness.rewriteCalls.at(-1);
    assertCondition(
      defaultListRewrite?.exportsSource.includes('class ListNode {') &&
        defaultListRewrite.exportsSource.includes('int value;') &&
        defaultListRewrite.exportsSource.includes('this.value = val;'),
      'Java worker should inject TraceCode-compatible fallback ListNode with val/value aliases'
    );

    const objectArrayInputCode = `class Solution {
  int solve(Object values) {
    return ((java.util.List<?>) values).size();
  }
}`;

    await harness.sendMessage<{ success: boolean }>('execute-with-tracing', {
      code: objectArrayInputCode,
      functionName: 'solve',
      inputs: { values: [1, null, [2, 3]] },
      executionStyle: 'function',
    });
    const objectArrayRewrite = harness.rewriteCalls.at(-1);
    assertCondition(
      objectArrayRewrite?.exportsSource.includes(
        'Object values = new java.util.ArrayList<Object>(java.util.Arrays.asList(1, null, new java.util.ArrayList<Object>(java.util.Arrays.asList(2, 3))));'
      ),
      'Java worker should materialize JSON arrays as Java lists when the signature expects Object'
    );
    console.log('PASS: java worker materializes canonical TreeNode/ListNode/Object array inputs');

    const nestedCustomMapInput = await harness.sendMessage<{
      success: boolean;
      output?: unknown;
      error?: string;
    }>('execute-with-tracing', {
      code: `import java.util.*;

class Solution {
  static class Campaign {
    int cap;
    int bid;

    Campaign(int cap, int bid) {
      this.cap = cap;
      this.bid = bid;
    }
  }

  int score(Map<String, Campaign> campaigns) {
    Campaign campaign = campaigns.get("a");
    return campaign.cap + campaign.bid;
  }
}`,
      functionName: 'score',
      inputs: { campaigns: { a: { bid: 5, cap: 7 } } },
      executionStyle: 'function',
    });
    assertCondition(
      nestedCustomMapInput.success === true,
      `Java nested custom map input should execute: ${nestedCustomMapInput.error ?? 'unknown error'}`
    );
    const nestedCustomMapRewrite = harness.rewriteCalls.at(-1);
    assertCondition(
      nestedCustomMapRewrite?.exportsSource.includes('Map<String, Solution.Campaign> campaigns') &&
        nestedCustomMapRewrite.exportsSource.includes('materializeObject(Solution.Campaign.class'),
      `Java nested custom map input should qualify and hydrate by expected type, received ${nestedCustomMapRewrite?.exportsSource ?? '<missing>'}`
    );
    console.log('PASS: java worker hydrates nested custom map inputs');

    const opsNoArgConstructorCode = `class HitCounter {
  HitCounter() {}
  void hit(int timestamp) {}
  int getHits(int timestamp) { return timestamp; }
}`;

    await harness.sendMessage<{ success: boolean }>('execute-with-tracing', {
      code: opsNoArgConstructorCode,
      functionName: 'HitCounter',
      inputs: {
        operations: ['HitCounter', 'hit', 'getHits'],
        arguments: [[1], [2], [3]],
      },
      executionStyle: 'ops-class',
    });
    const opsNoArgConstructorRewrite = harness.rewriteCalls.at(-1);
    assertCondition(
      opsNoArgConstructorRewrite?.exportsSource.includes('instance = new HitCounter();'),
      'Java ops-class worker should not pass fixture arguments to no-argument constructors'
    );
    assertCondition(
      opsNoArgConstructorRewrite?.exportsSource.includes('instance.hit(2);') &&
        opsNoArgConstructorRewrite.exportsSource.includes('out.add(instance.getHits(3));'),
      'Java ops-class worker should still pass method arguments according to method signatures'
    );

    await harness.sendMessage<{ success: boolean }>('execute-with-tracing', {
      code: opsNoArgConstructorCode,
      functionName: 'HitCounter',
      inputs: {
        operations: ['hit', 'getHits'],
        arguments: [[2], [3]],
      },
      executionStyle: 'ops-class',
    });
    const opsImplicitConstructorRewrite = harness.rewriteCalls.at(-1);
    assertCondition(
      opsImplicitConstructorRewrite?.exportsSource.includes('HitCounter instance = new HitCounter();') &&
        !opsImplicitConstructorRewrite.exportsSource.includes('out.add(null);\n    instance.hit(2);') &&
        opsImplicitConstructorRewrite.exportsSource.includes('instance.hit(2);') &&
        opsImplicitConstructorRewrite.exportsSource.includes('out.add(instance.getHits(3));'),
      'Java ops-class worker should instantiate once without consuming the first method when constructor op is omitted'
    );

    const opsInitConstructorCode = `class Cashier {
  Cashier(int n, int discount, int[] products, int[] prices) {}
  double getBill(int[] product, int[] amount) { return 0.0; }
}`;
    await harness.sendMessage<{ success: boolean }>('execute-with-tracing', {
      code: opsInitConstructorCode,
      functionName: 'Cashier',
      inputs: {
        operations: ['__init__', 'getBill'],
        arguments: [[3, 50, [1, 2], [100, 200]], [[1], [2]]],
      },
      executionStyle: 'ops-class',
    });
    const opsInitConstructorRewrite = harness.rewriteCalls.at(-1);
    assertCondition(
      opsInitConstructorRewrite?.exportsSource.includes('Cashier instance = new Cashier(3, 50, new int[] { 1, 2 }, new int[] { 100, 200 });') &&
        opsInitConstructorRewrite.exportsSource.includes('out.add(null);') &&
        opsInitConstructorRewrite.exportsSource.includes('out.add(instance.getBill(new int[] { 1 }, new int[] { 2 }));'),
      'Java ops-class worker should treat __init__ as the constructor operation'
    );
    console.log('PASS: java worker respects ops-class constructor signatures');

    const resultParameterCode = `class Solution {
  boolean canTransform(String start, String result) {
    return start.length() == result.length();
  }
}`;
    await harness.sendMessage<{ success: boolean }>('execute-with-tracing', {
      code: resultParameterCode,
      functionName: 'canTransform',
      inputs: { start: 'RX', result: 'XR' },
      executionStyle: 'function',
    });
    const resultParameterRewrite = harness.rewriteCalls.at(-1);
    assertCondition(
        resultParameterRewrite?.exportsSource.includes('String result = ((String) readJsonInput(') &&
        resultParameterRewrite.exportsSource.includes('boolean __tracecode_result = solution.canTransform(start, result);') &&
        resultParameterRewrite.exportsSource.includes('return TraceHooks.serializeOutputResult(__tracecode_result);'),
      'Java worker should avoid colliding with user parameter names when storing return values'
    );
    console.log('PASS: java worker avoids wrapper local name collisions');

    const scriptWithHelperCode = `import java.util.*;

static int uniquePaths(int rows, int cols) {
  int[][] dp = new int[rows][cols];
  for (int row = 0; row < rows; row++) dp[row][0] = 1;
  for (int col = 0; col < cols; col++) dp[0][col] = 1;
  for (int row = 1; row < rows; row++) {
    for (int col = 1; col < cols; col++) {
      dp[row][col] = dp[row - 1][col] + dp[row][col - 1];
    }
  }
  return dp[rows - 1][cols - 1];
}

Object result = uniquePaths(3, 4);`;

    const helperScriptExecute = await harness.sendMessage<{
      success: boolean;
      output: unknown;
      events?: string[];
      sourceText?: string;
    }>('execute-with-tracing', {
      code: scriptWithHelperCode,
      functionName: '',
      inputs: {},
      executionStyle: 'function',
    });

    assertCondition(helperScriptExecute.success === true, 'Java helper script execution should succeed');
    assertCondition(helperScriptExecute.output === 10, 'Java helper script should serialize output');
    assertCondition(
      Array.isArray(helperScriptExecute.events) &&
        helperScriptExecute.events.some((event) =>
          nativeEventMatches(event, {
            kind: 'write',
            line: 9,
            target: { variable: 'dp', path: [1, 1] },
            value: 2,
          })
        ),
      `Java helper script should remap helper body events to original source lines, got ${JSON.stringify(helperScriptExecute.events)}`
    );
    assertCondition(
      Array.isArray(helperScriptExecute.events) &&
        !helperScriptExecute.events.some((event) =>
          nativeEventMatches(event, {
            kind: 'write',
            line: 10,
            target: { variable: 'dp', path: [1, 1] },
            value: 2,
          })
        ),
      'Java helper script should not leave helper body events on generated brace lines'
    );
    assertCondition(
      Array.isArray(helperScriptExecute.events) &&
        helperScriptExecute.events.some((event) => nativeEventMatches(event, { kind: 'return', line: 15, function: '<module>' })),
      'Java helper script should remap generated script return to the top-level result line'
    );
    const helperEvents = Array.isArray(helperScriptExecute.events) ? helperScriptExecute.events : [];
    const repeatedInnerHeaderIndex = helperEvents.findIndex((event, index) =>
      nativeEventMatches(event, { kind: 'line', line: 8 }) &&
      index > 0 &&
      helperEvents.slice(0, index).some((prior) =>
        nativeEventMatches(prior, { kind: 'snapshot', line: 9, target: { variable: 'dp' } })
      )
    );
    assertCondition(
      repeatedInnerHeaderIndex > 0 &&
        helperEvents.slice(repeatedInnerHeaderIndex + 1, repeatedInnerHeaderIndex + 4).some((event) =>
          nativeEventMatches(event, { kind: 'line', line: 9 })
        ),
      `Java helper script should revisit the inner for line before repeated body iterations, got ${JSON.stringify(helperEvents)}`
    );
    const repeatedOuterHeaderIndex = helperEvents.findIndex((event, index) =>
      nativeEventMatches(event, { kind: 'line', line: 7 }) &&
      index > 0 &&
      helperEvents.slice(0, index).some((prior) =>
        nativeEventMatches(prior, { kind: 'snapshot', line: 9, target: { variable: 'dp' } })
      )
    );
    assertCondition(
      repeatedOuterHeaderIndex > 0 &&
        helperEvents.slice(repeatedOuterHeaderIndex + 1, repeatedOuterHeaderIndex + 4).some((event) =>
          nativeEventMatches(event, { kind: 'line', line: 8 })
        ),
      `Java helper script should revisit the outer for line before the next inner loop pass, got ${JSON.stringify(helperEvents)}`
    );
    const helperScriptRewrite = harness.rewriteCalls.at(-1);
    assertCondition(
      Boolean(helperScriptRewrite?.source.includes('static int uniquePaths(int rows, int cols)')),
      'Java script source should preserve top-level helper methods as Solution members'
    );
    assertCondition(
      helperScriptRewrite?.source.includes('for (int row = 0; row < rows; row++) { dp[row][0] = 1; }'),
      'Java script source should block-wrap helper single-statement for loop bodies before rewrite'
    );
    console.log('PASS: java script helper methods preserve original trace line mapping');

    const lowerBoundCode = `import java.util.*;

static int lowerBound(int[] nums, int target) {
  int left = 0;
  int right = nums.length;
  while (left < right) {
    int mid = left + (right - left) / 2;
    if (nums[mid] < target) left = mid + 1;
    else right = mid;
  }
  return left;
}

Object result = lowerBound(new int[] {1, 3, 3, 5, 8}, 4);`;

    const lowerBoundExecute = await harness.sendMessage<{ success: boolean; error?: string }>('execute-with-tracing', {
      code: lowerBoundCode,
      functionName: '',
      inputs: {},
      executionStyle: 'function',
    });
    assertCondition(lowerBoundExecute.success === true, `Java lowerBound execution should succeed: ${lowerBoundExecute.error ?? ''}`);

    const lowerBoundSource = latestSourceContaining(harness.stringFiles, 'lowerBound');
    assertCondition(
      lowerBoundSource.includes(
        'TraceHooks.emitCallAtLine(3, "lowerBound", "" + " nums=" + TraceHooks.serializeResult(nums) + " target=" + TraceHooks.serializeResult(target));'
      ),
      'Java rewritten call hook should serialize all live method arguments like JS/Python trace call snapshots'
    );
    assertCondition(
      lowerBoundSource.includes('int right = TraceHooks.readArrayLengthAtLine(5, "nums", nums);'),
      'Java rewritten array length reads should emit runtime indexed-state context'
    );
    const nestedArrayLengthSource = augmentRewrittenJavaForTest(`class Solution {
  public int width(char[][] grid) {
    if (grid == null || grid.length == 0 || grid[0].length == 0) return 0;
    return grid[0].length;
  }
}`);
    assertCondition(
      nestedArrayLengthSource.includes('TraceHooks.readArrayLengthAtLine(3, "grid", TraceHooks.readObjectArrayAtLine(3, "grid", grid, 0, null), 0, null)') &&
        nestedArrayLengthSource.includes('TraceHooks.readArrayLengthAtLine(4, "grid", TraceHooks.readObjectArrayAtLine(4, "grid", grid, 0, null), 0, null)'),
      `Java rewritten nested array length reads should emit grid[0].length as a nested metadata read, received ${nestedArrayLengthSource}`
    );
    assertJavaSourceCompiles(nestedArrayLengthSource, 'augmented Java nested array length source');
    const inlineReturnSource = assertNativeJavaRewriterCompiles(`class Solution {
  public int dfs(Integer node) {
    if (node == null) return 0;
    return node;
  }
}`, 'dfs');
    assertCondition(
      inlineReturnSource.includes('TraceHooks.emitSerializedReturnAtLine(3, "dfs", TraceHooks.serializeResult(__tracecodeReturnValue3));') &&
        inlineReturnSource.includes('int __tracecodeReturnValue3 = 0;'),
      'Java rewritten inline returns should emit typed concrete return values'
    );
    assertCondition(
      lowerBoundSource.includes(
        'TraceHooks.emitLineAtLine(8, "" + " nums=" + TraceHooks.serializeResult(nums) + " target=" + TraceHooks.serializeResult(target) + " left=" + TraceHooks.serializeResult(left) + " right=" + TraceHooks.serializeResult(right) + " mid=" + TraceHooks.serializeResult(mid));'
      ),
      'Java rewritten line hooks should emit visible method args and loop locals before indexed reads'
    );
    assertCondition(
      lowerBoundSource.includes('int __tracecodeReturnValue0 = left;') &&
        lowerBoundSource.includes(
          'TraceHooks.emitSerializedReturnAtLine(11, "lowerBound", TraceHooks.serializeResult(__tracecodeReturnValue0));'
        ) &&
        lowerBoundSource.includes('return __tracecodeReturnValue0;'),
      'Java rewritten return hooks should emit serialized return values like JS/Python'
    );
    console.log('PASS: java worker augments rewritten call hooks and return hooks with live snapshots');

    const twoPointerScalarUpdateSource = assertNativeJavaRewriterCompiles(`import java.util.*;

class Solution {
  public boolean two_pointers_converging(List<String> arr) {
    if (arr.isEmpty()) return true;
    int left = 0;
    int right = arr.size() - 1;
    while (left < right) {
      if (!Objects.equals(arr.get(left), arr.get(right))) return false;
      left += 1;
      right -= 1;
    }
    return true;
  }
}`, 'two_pointers_converging');
    assertCondition(
      twoPointerScalarUpdateSource.includes('TraceHooks.emitRuntimeSnapshotAtLine(10, "left", left);') &&
        twoPointerScalarUpdateSource.includes('TraceHooks.emitRuntimeSnapshotAtLine(11, "right", right);'),
      'Java rewritten scalar compound assignments should emit same-line runtime snapshots'
    );
    console.log('PASS: java worker snapshots scalar compound updates on the update line');

    const scalarDeclarationWriteSource = assertNativeJavaRewriterCompiles(`class TreeNode {
  int val;
  TreeNode left;
  TreeNode right;
}

class Solution {
  private int dfs(TreeNode node) {
    if (node == null) return 0;
    int leftGain = Math.max(0, dfs(node.left));
    int rightGain = Math.max(0, dfs(node.right));
    return node.val + Math.max(leftGain, rightGain);
  }
}`, 'dfs');
    assertCondition(
      scalarDeclarationWriteSource.includes('TraceHooks.emitScalarWriteAtLine(10, "leftGain", leftGain);') &&
        scalarDeclarationWriteSource.includes('TraceHooks.emitScalarWriteAtLine(11, "rightGain", rightGain);'),
      'Java rewritten scalar declarations with call initializers should emit same-line scalar write events'
    );
    console.log('PASS: java worker emits scalar write events for initialized local declarations');

    const multilineCollectionDeclarationSource = augmentRewrittenJavaForTest(`import java.util.*;
import java.util.stream.*;

class Solution {
  public boolean canSplitTeams(int n) {
    List<List<Integer>> adj = IntStream
        .range(0, n)
        .mapToObj(i -> new ArrayList<Integer>())
        .collect(Collectors.toList());
    return adj.size() == n;
  }
}`, 'canSplitTeams');
    assertCondition(
      multilineCollectionDeclarationSource.includes('TraceHooks.emitScalarWriteAtLine(6, "adj", adj);'),
      'Java rewritten multiline local declarations should emit a creation write at the declaration line'
    );
    assertJavaSourceCompiles(multilineCollectionDeclarationSource, 'augmented Java multiline collection declaration source');

    const multilineArrayDeclarationSource = augmentRewrittenJavaForTest(`class Solution {
  public int solve(int[] cell) {
    int row = cell[0];
    int col = cell[1];
    int[][] neighbors = new int[][] {
      new int[] { row + 1, col },
      new int[] { row - 1, col }
    };
    return neighbors.length;
  }
    }`, 'solve');
    assertCondition(
      multilineArrayDeclarationSource.includes('TraceHooks.emitLineAtLine(5,') &&
        multilineArrayDeclarationSource.includes('TraceHooks.emitScalarWriteAtLine(5, "neighbors", neighbors);') &&
        !multilineArrayDeclarationSource.includes('TraceHooks.emitScalarWriteAtLine(4, "neighbors", neighbors);') &&
        !multilineArrayDeclarationSource.includes('TraceHooks.emitScalarWriteAtLine(9, "neighbors", neighbors);'),
      'Java rewritten multiline array declarations should emit creation writes on the declaration line, not the previous executable line or closing initializer line'
    );
    assertJavaSourceCompiles(multilineArrayDeclarationSource, 'augmented Java multiline array declaration source');
    console.log('PASS: java worker emits scalar writes for multiline initialized local declarations');

    const tracedArrayLengthIndexSource = assertNativeJavaRewriterCompiles(`class Solution {
  public int solve(int[] days) {
    int lastDay = days[days.length - 1];
    return lastDay;
  }
}`, 'solve');
    assertCondition(
      tracedArrayLengthIndexSource.includes('TraceHooks.readIntArrayAtLine(3, "days", days, days.length - 1, "days.length - 1");') &&
        !tracedArrayLengthIndexSource.includes('"TraceHooks.readArrayLengthAtLine'),
      'Java array reads with traced length expressions should not emit unescaped TraceHooks source strings'
    );

    const multilineControlHeaderSource = assertNativeJavaRewriterCompiles(`class Solution {
  public boolean solve(int[][] grid, boolean[][] visited, int nextRow, int nextCol, int n) {
    if (
      nextRow >= 0 && nextRow < n &&
      nextCol >= 0 && nextCol < n &&
      !visited[nextRow][nextCol] &&
      grid[nextRow][nextCol] == 0
    ) {
      visited[nextRow][nextCol] = true;
      return true;
    }
    return false;
  }
}`, 'solve');
    assertCondition(
      !multilineControlHeaderSource.includes('TraceHooks.emitLineAtLine(8') ||
        multilineControlHeaderSource.indexOf('TraceHooks.emitLineAtLine(8') > multilineControlHeaderSource.indexOf(') {'),
      'Java multiline control header closing line should not receive an injected line hook before the closing paren'
    );

    const lambdaInitializerSource = augmentRewrittenJavaForTest(`import java.util.PriorityQueue;

class Solution {
  public int solve(int[][] matrix) {
    PriorityQueue<int[]> heap = new PriorityQueue<>((a, b) -> {
      if (a[0] != b[0]) return Integer.compare(a[0], b[0]);
      return Integer.compare(a[1], b[1]);
    });
    heap.offer(new int[] { matrix[0][0], 0 });
    return heap.peek()[0];
  }
}`, 'solve');
    assertJavaSourceCompiles(lambdaInitializerSource, 'augmented Java lambda initializer source');
    assertCondition(
      !lambdaInitializerSource.includes('TraceHooks.emitScalarWriteAtLine(5, "heap", heap);'),
      'Java lambda/block initializers should not emit local declaration writes inside the initializer before assignment completes'
    );

    const twoSumCode = `import java.util.*;

class Solution {
  public int[] twoSum(int[] nums, int target) {
    Map<Integer, Integer> seen = new HashMap<>();
    for (int i = 0; i < nums.length; i++) {
      int complement = target - nums[i];
      if (seen.containsKey(complement)) {
        return new int[] { seen.get(complement), i };
      }
      seen.put(nums[i], i);
    }
    return new int[0];
  }
}`;

    await harness.sendMessage<{ success: boolean }>('execute-with-tracing', {
      code: twoSumCode,
      functionName: 'twoSum',
      inputs: { nums: [2, 7, 11, 15], target: 9 },
      executionStyle: 'function',
    });

    const twoSumSource = latestSourceContaining(harness.stringFiles, 'TraceHooks.emitCallAtLine(4, "twoSum"');
    assertCondition(
      twoSumSource.includes('TraceHooks.containsMapKeyAtLine(8, "seen", seen, complement, "complement")'),
      'Java worker should rewrite Map.containsKey into keyed TraceHooks access'
    );
    assertCondition(
      twoSumSource.includes('TraceHooks.readMapAtLine(9, "seen", seen, complement, "complement")'),
      'Java worker should rewrite Map.get into keyed TraceHooks read'
    );
    assertCondition(
      twoSumSource.includes('TraceHooks.writeMapAtLine(11, "seen", seen, TraceHooks.readIntArrayAtLine(11, "nums", nums, i, "i"), i, "nums[i]");'),
      'Java worker should rewrite Map.put into keyed TraceHooks write while preserving key expression provenance'
    );
    assertCondition(
      !twoSumSource.includes('TraceHooks.emitMutatingCallAtLine(11, "seen", "put");'),
      'Java worker should remove stale generic Map mutation events after keyed rewrite'
    );
    assertCondition(
      twoSumSource.includes(
        'TraceHooks.emitLineAtLine(7, "" + " nums=" + TraceHooks.serializeResult(nums) + " target=" + TraceHooks.serializeResult(target) + " seen=" + TraceHooks.serializeResult(seen) + " i=" + TraceHooks.serializeResult(i));'
      ),
      'Java worker should emit loop index locals on loop body line hooks'
    );
    console.log('PASS: java worker rewrites Map operations to keyed runtime trace hooks');

    const foreachCode = `import java.util.*;

class Solution {
  public int totalLength(List<String> words) {
    int total = 0;
    for (String word : words) {
      total += word.length();
    }
    return total;
  }
}`;

    const foreachExecute = await harness.sendMessage<{
      success: boolean;
      events?: string[];
    }>('execute-with-tracing', {
      code: foreachCode,
      functionName: 'totalLength',
      inputs: { words: ['za', 'x'] },
      executionStyle: 'function',
    });
    assertCondition(foreachExecute.success === true, 'Java enhanced-for trace should execute successfully');
    const foreachSource = latestSourceContaining(harness.stringFiles, 'TraceHooks.iterationBindAtLine');
    assertCondition(
      foreachSource.includes('TraceHooks.iterationBindAtLine(') &&
        foreachSource.includes('"words", words, "word"'),
      'Java worker should wrap enhanced-for collection bindings with runtime iteration reads'
    );

    const foreachCharSource = augmentRewrittenJavaForTest(`import java.util.*;

class Solution {
  public int countChars(List<String> words) {
    int total = 0;
    for (String word : words) {
      for (char ch : word.toCharArray()) {
        total += ch == 'a' ? 1 : 0;
      }
    }
    return total;
  }
}`, 'countChars');
    assertCondition(
      foreachCharSource.includes('for (char ch : TraceHooks.iterationBindAtLine(7, "word", word.toCharArray(), "ch")) {'),
      `Java worker should wrap foreach over word.toCharArray() with string character iteration binding reads, received ${foreachCharSource}`
    );

    const foreachArraySource = augmentRewrittenJavaForTest(`class Solution {
  public int totalAccounts(Object[][] accounts) {
    int total = 0;
    for (Object[] account : accounts) {
      total += account.length;
    }
    return total;
  }
}`, 'totalAccounts');
    assertCondition(
      foreachArraySource.includes('TraceHooks.iterationBindAtLine(4, "accounts", accounts, "account")'),
      'Java worker should wrap enhanced-for bindings over multidimensional array parameters'
    );

    const foreachArrayExecute = await harness.sendMessage<{
      success: boolean;
      output: unknown;
      events?: string[];
    }>('execute-with-tracing', {
      code: `class Solution {
  public int totalAccounts(Object[][] accounts) {
    int total = 0;
    for (Object[] account : accounts) {
      total += account.length;
    }
    return total;
  }
}`,
      functionName: 'totalAccounts',
      inputs: { accounts: [['John', 'a@mail'], ['Ada', 'b@mail', 'c@mail']] },
      executionStyle: 'function',
    });
    assertCondition(foreachArrayExecute.success === true, 'Java Object[][] enhanced-for trace should execute successfully');
    const foreachArrayTrace = javaTraceHooksEventsToRuntimeTrace(foreachArrayExecute.events ?? [], undefined, {
      runId: 'java:test',
      file: 'solution.java',
    });
    assertCondition(
      foreachArrayTrace.events.some((event) =>
        event.kind === 'read' &&
        event.line === 4 &&
        'variable' in event.target &&
        event.target.variable === 'accounts' &&
        'path' in event.target &&
        JSON.stringify(event.target.path) === JSON.stringify([0]) &&
        event.binding?.kind === 'iteration' &&
        event.binding.variable === 'account'
      ),
      `Java enhanced-for over Object[][] should emit an iteration binding read, received ${JSON.stringify(foreachArrayTrace.events)}`
    );
    console.log('PASS: java worker emits enhanced-for iteration binding reads');

    const defaultMapCode = `import java.util.*;

class Solution {
  public int solve(int[] nums) {
    Map<Integer, Integer> freq = new HashMap<>();
    freq.put(1, freq.getOrDefault(1, 0) + 1);
    return freq.get(1);
  }
}`;

    const defaultMapExecute = await harness.sendMessage<{
      success: boolean;
      events?: string[];
    }>('execute-with-tracing', {
      code: defaultMapCode,
      functionName: 'solve',
      inputs: { nums: [1] },
      executionStyle: 'function',
    });
    assertCondition(defaultMapExecute.success === true, 'Java Map.getOrDefault update execution should succeed');

    const defaultMapSource = latestSourceContaining(harness.stringFiles, 'TraceHooks.readMapOrDefaultAtLine');
    assertCondition(
      defaultMapSource.includes('TraceHooks.readMapOrDefaultAtLine(6, "freq", freq, 1, 0, null)'),
      'Java worker should rewrite Map.getOrDefault into keyed TraceHooks get access'
    );
    assertCondition(
      defaultMapSource.includes('TraceHooks.writeMapAtLine(6, "freq", freq, 1, TraceHooks.readMapOrDefaultAtLine(6, "freq", freq, 1, 0, null) + 1, null);'),
      'Java worker should rewrite Map.put with literal keys while preserving getOrDefault instrumentation'
    );
    console.log('PASS: java worker rewrites Map.getOrDefault default updates');

    const mapOfListsCode = `import java.util.*;

class Solution {
  public int solve(int[] arr) {
    Map<Integer, List<Integer>> valueIndices = new HashMap<>();
    for (int i = 0; i < arr.length; i++) {
      valueIndices.computeIfAbsent(arr[i], k -> new ArrayList<>()).add(i);
    }
    int total = 0;
    for (int j : valueIndices.get(arr[0])) {
      total += j;
    }
    return total;
  }
}`;

    const mapOfListsExecute = await harness.sendMessage<{ success: boolean; error?: string }>('execute-with-tracing', {
      code: mapOfListsCode,
      functionName: 'solve',
      inputs: { arr: [11, 22, 11] },
      executionStyle: 'function',
    });

    assertCondition(
      mapOfListsExecute.success === true,
      `Java Map<K,List<V>> get execution should compile and trace: ${mapOfListsExecute.error ?? ''}`
    );
    const mapOfListsSource = latestSourceContaining(harness.stringFiles, 'Map<Integer, List<Integer>> valueIndices');
    assertCondition(
      mapOfListsSource.includes('TraceHooks.readMapAtLine(10, "valueIndices", valueIndices,'),
      'Java worker should classify Map<K,List<V>>.get as a keyed map read, not a list index read'
    );
    assertCondition(
      !mapOfListsSource.includes('TraceHooks.readListAtLine(10, "valueIndices", valueIndices'),
      'Java worker should not rewrite Map<K,List<V>>.get to readListAtLine'
    );
    console.log('PASS: java worker rewrites Map<K,List<V>>.get as keyed map reads');

    const graphCode = `import java.util.*;

class Solution {
  int[] buildGraph(int n) {
    List<List<Integer>> graph = new ArrayList<>();
    for (int i = 0; i < n; i++) graph.add(new ArrayList<>());
    graph.get(0).add(1);
    graph.get(1).add(2);
    int[] order = new int[n];
    for (int u = 0; u < n; u++) {
      for (int v : graph.get(u)) {
        order[v] = v;
      }
    }
    return order;
  }
}`;

    const graphExecute = await harness.sendMessage<{
      success: boolean;
      output: unknown;
      events?: string[];
    }>('execute-with-tracing', {
      code: graphCode,
      functionName: 'buildGraph',
      inputs: { n: 3 },
      executionStyle: 'function',
    });

    assertCondition(graphExecute.success === true, 'Java graph adjacency execution should succeed');
    const graphSource = latestSourceContaining(harness.stringFiles, 'TraceHooks.emitCallAtLine(4, "buildGraph"');
    const graphHasAugmentedIndexedAppend =
      graphSource.includes('TraceHooks.readObjectListAtLine(7, "graph", graph, 0, null)') &&
      graphSource.includes('__tracecodeTarget.add(1);') &&
      graphSource.includes('TraceHooks.emitMutatingCallAtLine(7, "graph", 0, "add", null, 1);') &&
      graphSource.includes('TraceHooks.emitIndexedWriteAtLine(7, "graph", new Object[] { 0, __tracecodeTarget.size() - 1 }, 1, null, null);');
    const graphHasNativeIndexedAppend =
      graphSource.includes('var __tracecodeIndexedTarget7 =') &&
      graphSource.includes('__tracecodeIndexedTarget7.add(1);') &&
      graphSource.includes('\\"kind\\":\\"mutate\\",\\"line\\":7') &&
      graphSource.includes('TraceHooks.emitIndexedWriteAtLine(7, "graph", new Object[] { 0, ((java.util.List) __tracecodeIndexedTarget7).size() - 1 }, 1, null, null);');
    assertCondition(
      (graphHasAugmentedIndexedAppend || graphHasNativeIndexedAppend) &&
        !graphSource.includes('emit' + 'Graph' + 'AdjacencyStateAtLine'),
      'Java worker should rewrite indexed adjacency mutations with receiver indices and inserted-cell writes without semantic graph state'
    );
    assertCondition(
      graphSource.includes('for (int v : TraceHooks.iterationBindAtLine(11, "graph", u,') &&
        (graphSource.includes('TraceHooks.readObjectListAtLine(11, "graph", graph, u, "u")') ||
          graphSource.includes('TraceHooks.readListAtLine(11, "graph", graph, u, "u")')),
      'Java worker should rewrite adjacency traversal graph.get(u) reads with iteration binding provenance'
    );
    assertCondition(JSON.stringify(graphExecute.output) === JSON.stringify([0, 1, 2]), 'Java graph adjacency output should serialize result');
    assertCondition(
      Array.isArray(graphExecute.events) &&
        graphExecute.events.every((event) => event.startsWith('trace:')),
      'Java graph adjacency runtime events should be native runtime trace'
    );

    const graphTrace = javaTraceHooksEventsToRuntimeTrace(graphExecute.events ?? [], undefined, {
      runId: 'java:test',
      file: 'solution.java',
    });
    assertCondition(
      graphTrace.events.some((event) =>
        event.kind === 'mutate' &&
        'variable' in event.target &&
        event.target.variable === 'graph' &&
        event.method === 'add' &&
        'path' in event.target &&
        JSON.stringify(event.target.path) === JSON.stringify([0])
      ),
      'Java graph adjacency runtime events should emit runtime trace indexed receiver mutations'
    );
    assertCondition(
      graphTrace.events.some((event) =>
        event.kind === 'read' &&
        'variable' in event.target &&
        event.target.variable === 'graph' &&
        'path' in event.target &&
        JSON.stringify(event.target.path) === JSON.stringify([0])
      ),
      'Java graph adjacency traversal should emit runtime trace indexed reads'
    );
    assertCondition(
      !JSON.stringify(graphTrace.events).includes('graph-adjacency') &&
        !JSON.stringify(graphTrace.events).includes('objectKinds'),
      'Java runtime trace graph traces should not carry visualization classifications'
    );
    console.log('PASS: java worker indexed receiver graph operations emit neutral runtime trace accesses');

    const nestedListSetCode = `import java.util.*;

class Solution {
  int solve() {
    List<List<Integer>> dp = new ArrayList<>();
    dp.add(new ArrayList<>(Arrays.asList(0, 0)));
    int j = 1;
    dp.get(0).set(j, 7);
    return dp.get(0).get(j);
  }
}`;

    const nestedListSetSource = assertNativeJavaRewriterCompiles(nestedListSetCode, 'solve');
    assertCondition(
      !nestedListSetSource.includes(' + "," + "," + "" + '),
      `Java nested List.set mutate source should not emit malformed JSON separators, received ${nestedListSetSource}`
    );
    assertCondition(
      nestedListSetSource.includes('\\"args\\":[" + TraceHooks.serializeResult(j) + "," + TraceHooks.serializeResult(7) + "]'),
      `Java nested List.set mutate source should emit valid [index,value] args, received ${nestedListSetSource}`
    );
    console.log('PASS: java worker emits valid nested List.set mutate args');

    const cloneGraphCode = `import java.util.*;

class Solution {
  public int countReachable(int[][] adjList) {
    boolean[] visited = new boolean[adjList.length];
    dfs(0, adjList, visited);
    int count = 0;
    for (boolean flag : visited) {
      if (flag) count++;
    }
    return count;
  }

  private void dfs(int node, int[][] adjList, boolean[] visited) {
    if (visited[node]) return;
    visited[node] = true;
    for (int neighbor : adjList[node]) {
      int neighborIndex = neighbor - 1;
      if (neighborIndex >= 0 && neighborIndex < adjList.length && !visited[neighborIndex]) {
        dfs(neighborIndex, adjList, visited);
      }
    }
  }
}`;

    const cloneGraphSource = assertNativeJavaRewriterCompiles(cloneGraphCode, 'countReachable');
    assertCondition(
      cloneGraphSource.includes('TraceHooks.emitReturnAtLine(23, "dfs");'),
      `Java rewriter should emit an implicit return hook before recursive void helper exit, received ${cloneGraphSource}`
    );
    console.log('PASS: java rewriter emits implicit returns for recursive void helpers');

    const mutatingExpressionCode = `import java.util.*;
class Solution {
  int solve() {
    PriorityQueue<Integer> heap = new PriorityQueue<>();
    heap.offer(1);
    int top = heap.poll();
    top = heap.poll();
    return top;
  }
}`;
    const mutatingExpressionSource = augmentRewrittenJavaForTest(mutatingExpressionCode, 'solve');
    assertCondition(
      /int top = TraceHooks\.pollQueueAtLine\(\d+, "heap", heap\);/.test(mutatingExpressionSource),
      'Java worker should rewrite queue poll declaration RHS mutations to value-returning V4 hooks'
    );
    assertCondition(
      /top = TraceHooks\.pollQueueAtLine\(\d+, "heap", heap\);\s*\n\s*(?:TraceHooks\.emitScalarWriteAtLine\(\d+, "top", top\);\s*\n\s*)?TraceHooks\.emitRuntimeSnapshotAtLine\(\d+, "top", top\);/.test(mutatingExpressionSource),
      'Java worker should rewrite queue poll assignment RHS mutations to value-returning V4 hooks'
    );
    console.log('PASS: java worker snapshots receiver state after mutating RHS expressions');

    const heapSetCode = `import java.util.*;
class Solution {
  int solve() {
    List<Integer> heap = new ArrayList<>();
    heap.add(4);
    heap.add(9);
    int i = 1;
    int parent = 0;
    int tmp = heap.get(parent);
    heap.set(parent, heap.get(i));
    heap.set(i, tmp);
    heap.set(0, heap.get(i));
    return heap.get(0);
  }
}`;
    const heapSetSource = assertNativeJavaRewriterCompiles(heapSetCode);
    assertCondition(
      heapSetSource.includes('TraceHooks.writeListAtLine(10, "heap", heap, parent, TraceHooks.readListAtLine(10, "heap", heap, i, "i"), "parent")') &&
        heapSetSource.includes('TraceHooks.writeListAtLine(11, "heap", heap, i, tmp, "i")') &&
        heapSetSource.includes('TraceHooks.writeListAtLine(12, "heap", heap, 0, TraceHooks.readListAtLine(12, "heap", heap, i, "i"), null)'),
      'Java rewriter should route List.set heap mutations through writeListAtLine hooks'
    );

    const heapSetTmpRoot = mkdtempSync(join(tmpdir(), 'tracecode-java-heap-set-hooks-'));
    let heapSetHookEvents: string[] = [];
    try {
      const sourcePath = join(heapSetTmpRoot, 'Main.java');
      const classesPath = join(heapSetTmpRoot, 'classes');
      writeFileSync(
        sourcePath,
        `import tracecode.user.TraceHooks;
import java.util.*;
public class Main {
  public static void main(String[] args) {
    TraceHooks.reset();
    List<Integer> heap = new ArrayList<>();
    heap.add(4);
    heap.add(9);
    TraceHooks.writeListAtLine(10, "heap", heap, 0, heap.get(1), "parent");
    TraceHooks.writeListAtLine(11, "heap", heap, 1, 4, "i");
    for (String event : TraceHooks.drainEvents()) System.out.println(event);
  }
}`
      );
      execFileSync('mkdir', ['-p', classesPath]);
      execFileSync('javac', ['-cp', join(process.cwd(), 'workers', 'vendor', 'java-browser-helper.jar'), '-d', classesPath, sourcePath], {
        cwd: process.cwd(),
        stdio: 'pipe',
      });
      heapSetHookEvents = execFileSync('java', ['-cp', [classesPath, join(process.cwd(), 'workers', 'vendor', 'java-browser-helper.jar')].join(':'), 'Main'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: 'pipe',
      }).trim().split(/\r?\n/).filter(Boolean);
    } finally {
      rmSync(heapSetTmpRoot, { recursive: true, force: true });
    }
    const heapSetTrace = javaTraceHooksEventsToRuntimeTrace(heapSetHookEvents, undefined, {
      runId: 'java:test',
      file: 'solution.java',
    });
    const heapSetMutations = heapSetTrace.events.filter(
      (event) =>
        event.kind === 'mutate' &&
        'variable' in event.target &&
        event.target.variable === 'heap' &&
        event.method === 'set'
    );
    assertCondition(
      heapSetMutations.some((event) => JSON.stringify(event.args) === JSON.stringify([0, 9])) &&
        heapSetMutations.some((event) => JSON.stringify(event.args) === JSON.stringify([1, 4])),
      `Java List.set hooks should emit mutate events with evaluated [index,value] args, received ${JSON.stringify(heapSetMutations)}`
    );
    console.log('PASS: java worker emits List.set mutate events with evaluated args');

    const priorityQueueTmpRoot = mkdtempSync(join(tmpdir(), 'tracecode-java-priority-queue-writes-'));
    let priorityQueueHookEvents: string[] = [];
    try {
      const sourcePath = join(priorityQueueTmpRoot, 'Main.java');
      const classesPath = join(priorityQueueTmpRoot, 'classes');
      writeFileSync(
        sourcePath,
        `import tracecode.user.TraceHooks;
import java.util.*;
public class Main {
  public static void main(String[] args) {
    TraceHooks.reset();
    PriorityQueue<Integer> heap = new PriorityQueue<>();
    TraceHooks.offerQueueAtLine(5, "heap", heap, 4);
    TraceHooks.offerQueueAtLine(6, "heap", heap, 2);
    TraceHooks.pollQueueAtLine(7, "heap", heap);
    for (String event : TraceHooks.drainEvents()) System.out.println(event);
  }
}`
      );
      execFileSync('mkdir', ['-p', classesPath]);
      execFileSync('javac', ['-cp', join(process.cwd(), 'workers', 'vendor', 'java-browser-helper.jar'), '-d', classesPath, sourcePath], {
        cwd: process.cwd(),
        stdio: 'pipe',
      });
      priorityQueueHookEvents = execFileSync('java', ['-cp', [classesPath, join(process.cwd(), 'workers', 'vendor', 'java-browser-helper.jar')].join(':'), 'Main'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: 'pipe',
      }).trim().split(/\r?\n/).filter(Boolean);
    } finally {
      rmSync(priorityQueueTmpRoot, { recursive: true, force: true });
    }
    const priorityQueueTrace = javaTraceHooksEventsToRuntimeTrace(priorityQueueHookEvents, undefined, {
      runId: 'java:test',
      file: 'solution.java',
    });
    assertCondition(
      priorityQueueTrace.events.some((event) =>
        event.kind === 'write' &&
        event.target?.variable === 'heap' &&
        JSON.stringify(event.target.path) === JSON.stringify([0]) &&
        event.value === 2
      ) &&
        priorityQueueTrace.events.some((event) =>
          event.kind === 'write' &&
          event.target?.variable === 'heap' &&
          JSON.stringify(event.target.path) === JSON.stringify([1]) &&
          event.value === 4
        ),
      `Java PriorityQueue offer should emit concrete indexed writes for heap cells, received ${JSON.stringify(priorityQueueTrace.events)}`
    );
    assertCondition(
      priorityQueueTrace.events.some((event) =>
        event.kind === 'write' &&
        event.target?.variable === 'heap' &&
        JSON.stringify(event.target.path) === JSON.stringify([0]) &&
        event.value === 4
      ),
      `Java PriorityQueue poll should emit concrete indexed writes for shifted heap cells, received ${JSON.stringify(priorityQueueTrace.events)}`
    );
    console.log('PASS: java worker emits PriorityQueue concrete heap writes');

    const priorityQueueFieldSource = assertNativeJavaRewriterCompiles(`import java.util.*;
class MedianFinder {
  private final PriorityQueue<Integer> lower = new PriorityQueue<>(Collections.reverseOrder());
  private final PriorityQueue<Integer> upper = new PriorityQueue<>();
  public Void addNum(int num) {
    lower.add(num);
    upper.add(lower.remove());
    return null;
  }
}`);
    assertCondition(
      priorityQueueFieldSource.includes('TraceHooks.emitCollectionIndexedWritesAtLine(6, "lower", lower)') &&
        priorityQueueFieldSource.includes('TraceHooks.removeQueueAtLine(7, "lower", lower)') &&
        priorityQueueFieldSource.includes('TraceHooks.emitCollectionIndexedWritesAtLine(7, "upper", upper)'),
      `Java rewriter should emit concrete PriorityQueue writes for field add/remove calls, received ${priorityQueueFieldSource}`
    );

    const stackPopIndexCode = `import java.util.*;
class Solution {
  int solve(int[] heights) {
    Deque<Integer> stack = new ArrayDeque<>();
    stack.push(0);
    int poppedHeight = heights[stack.pop()];
    return poppedHeight;
  }
}`;
    assertCondition(
      assertNativeJavaRewriterCompiles(stackPopIndexCode).includes(
        'TraceHooks.readIntArrayAtLine(6, "heights", heights, TraceHooks.popDequeAtLine(6, "stack", stack), "stack.pop()")'
      ),
      'Java rewriter should preserve array-read evidence while wrapping Deque.pop index mutations'
    );
    const stackPopTmpRoot = mkdtempSync(join(tmpdir(), 'tracecode-java-stack-pop-hooks-'));
    let stackPopHookEvents: string[] = [];
    try {
      const sourcePath = join(stackPopTmpRoot, 'Main.java');
      const classesPath = join(stackPopTmpRoot, 'classes');
      writeFileSync(
        sourcePath,
        `import tracecode.user.TraceHooks;
import java.util.*;
public class Main {
  public static void main(String[] args) {
    TraceHooks.reset();
    Deque<Integer> stack = new ArrayDeque<>();
    stack.push(0);
    TraceHooks.popDequeAtLine(6, "stack", stack);
    for (String event : TraceHooks.drainEvents()) System.out.println(event);
  }
}`
      );
      execFileSync('mkdir', ['-p', classesPath]);
      execFileSync('javac', ['-cp', join(process.cwd(), 'workers', 'vendor', 'java-browser-helper.jar'), '-d', classesPath, sourcePath], {
        cwd: process.cwd(),
        stdio: 'pipe',
      });
      stackPopHookEvents = execFileSync('java', ['-cp', [classesPath, join(process.cwd(), 'workers', 'vendor', 'java-browser-helper.jar')].join(':'), 'Main'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: 'pipe',
      }).trim().split(/\r?\n/).filter(Boolean);
    } finally {
      rmSync(stackPopTmpRoot, { recursive: true, force: true });
    }
    const stackPopIndexTrace = javaTraceHooksEventsToRuntimeTrace(stackPopHookEvents, undefined, {
      runId: 'java:test',
      file: 'solution.java',
    });
    assertCondition(
      stackPopIndexTrace.events.some(
        (event) =>
          event.kind === 'mutate' &&
          'variable' in event.target &&
          event.target.variable === 'stack' &&
          event.method === 'pop' &&
          JSON.stringify(event.args) === JSON.stringify([])
      ),
      `Java Deque.pop used as an array index should emit a no-arg mutate event, received ${JSON.stringify(stackPopIndexTrace.events)}`
    );
    console.log('PASS: java worker emits pop mutate events for array-index expressions');

    const fieldListCode = `import java.util.*;

class Solution {
  private List<Integer> values;

  public int solve(int n) {
    values = new ArrayList<>();
    values.add(n);
    return values.size();
  }
}`;

    const fieldListExecute = await harness.sendMessage<{
      success: boolean;
      output: unknown;
      events?: string[];
    }>('execute-with-tracing', {
      code: fieldListCode,
      functionName: 'solve',
      inputs: { n: 4 },
      executionStyle: 'function',
    });
    assertCondition(fieldListExecute.success === true, 'Java field list mutation execution should succeed');
    const fieldListTrace = javaTraceHooksEventsToRuntimeTrace(fieldListExecute.events ?? [], undefined, {
      runId: 'java:test',
      file: 'solution.java',
    });
    assertCondition(
      fieldListTrace.events.some((event) =>
        event.kind === 'mutate' &&
        'variable' in event.target &&
        event.target.variable === 'this' &&
        event.method === 'add' &&
        'path' in event.target &&
        JSON.stringify(event.target.path) === JSON.stringify(['values'])
      ),
      'Java field collection mutations should emit this-field mutate runtime events'
    );
    console.log('PASS: java worker rewrites field collection mutations as this-field runtime trace events');

    const putIfAbsentCode = `import java.util.*;

class Solution {
  public int order(String[] letters) {
    Map<String, Integer> inDegree = new HashMap<>();
    for (String ch : letters) {
      inDegree.putIfAbsent(ch, 0);
    }
    return inDegree.size();
  }
}`;
    const putIfAbsentExecute = await harness.sendMessage<{
      success: boolean;
      output: unknown;
      events?: string[];
    }>('execute-with-tracing', {
      code: putIfAbsentCode,
      functionName: 'order',
      inputs: { letters: ['z', 'a', 'z'] },
      executionStyle: 'function',
    });
    assertCondition(putIfAbsentExecute.success === true, 'Java putIfAbsent trace should execute successfully');
    const putIfAbsentTrace = javaTraceHooksEventsToRuntimeTrace(putIfAbsentExecute.events ?? [], undefined, {
      runId: 'java:test',
      file: 'solution.java',
    });
    assertCondition(
      putIfAbsentTrace.events.some((event) =>
        event.kind === 'mutate' &&
        event.line === 7 &&
        'variable' in event.target &&
        event.target.variable === 'inDegree' &&
        'path' in event.target &&
        JSON.stringify(event.target.path) === JSON.stringify(['z']) &&
        event.method === 'putIfAbsent' &&
        JSON.stringify(event.args) === JSON.stringify(['z', 0]) &&
        JSON.stringify(event.target.indexSources) === JSON.stringify(['ch'])
      ),
      `Java putIfAbsent should emit keyed mutate args and index-source evidence, received ${JSON.stringify(putIfAbsentTrace.events)}`
    );
    console.log('PASS: java worker emits putIfAbsent mutation args and keyed evidence');

    const fieldPutIfAbsentCode = `import java.util.*;

class Solution {
  static class TrieNode {
    Map<Character, TrieNode> children = new HashMap<>();
  }

  public int insert(String word) {
    TrieNode node = new TrieNode();
    for (char ch : word.toCharArray()) {
      node.children.putIfAbsent(ch, new TrieNode());
    }
    return node.children.size();
  }
}`;
    const fieldPutIfAbsentExecute = await harness.sendMessage<{
      success: boolean;
      output: unknown;
      events?: string[];
    }>('execute-with-tracing', {
      code: fieldPutIfAbsentCode,
      functionName: 'insert',
      inputs: { word: 'app' },
      executionStyle: 'function',
    });
    assertCondition(fieldPutIfAbsentExecute.success === true, 'Java field putIfAbsent trace should execute successfully');
    const fieldPutIfAbsentTrace = javaTraceHooksEventsToRuntimeTrace(fieldPutIfAbsentExecute.events ?? [], undefined, {
      runId: 'java:test',
      file: 'solution.java',
    });
    assertCondition(
      fieldPutIfAbsentTrace.events.some((event) =>
        event.kind === 'mutate' &&
        event.line === 10 &&
        'variable' in event.target &&
        event.target.variable === 'node' &&
        'path' in event.target &&
        JSON.stringify(event.target.path) === JSON.stringify(['children', 'a']) &&
        event.method === 'putIfAbsent' &&
        event.args?.[0] === 'a' &&
        JSON.stringify(event.target.indexSources) === JSON.stringify([null, 'ch'])
      ),
      `Java field putIfAbsent should emit keyed mutate args and index-source evidence, received ${JSON.stringify(fieldPutIfAbsentTrace.events)}`
    );
    console.log('PASS: java worker emits field putIfAbsent mutation args and keyed evidence');

    const fieldMapReadCode = `import java.util.*;

class Solution {
  static class TrieNode {
    Map<String, TrieNode> children = new HashMap<>();
  }

  public int walk(String word) {
    TrieNode node = new TrieNode();
    for (char ch : word.toCharArray()) {
      if (!node.children.containsKey(String.valueOf(ch))) {
        node.children.put(String.valueOf(ch), new TrieNode());
      }
      node = node.children.get(String.valueOf(ch));
    }
    return node.children.size();
  }
}`;
    const fieldMapReadSource = assertNativeJavaRewriterCompiles(fieldMapReadCode, 'walk');
    assertCondition(
      fieldMapReadSource.includes('TraceHooks.containsFieldMapKeyAtLine') &&
        fieldMapReadSource.includes('TraceHooks.readFieldMapAtLine') &&
        fieldMapReadSource.includes('String.valueOf(ch)'),
      `Java field map containsKey/get with computed keys should rewrite to keyed reads, received ${fieldMapReadSource}`
    );
    console.log('PASS: java rewriter emits keyed field-map reads for computed containsKey/get keys');

    const fieldPathWriteCode = `class Node {
  Node next;
  Node prev;
}

class Solution {
  Node head;
  Node tail;

  public int wire() {
    this.head = new Node();
    this.tail = new Node();
    this.head.next = this.tail;
    this.tail.prev = this.head;
    head.next.prev = tail;
    return 0;
  }
}`;
    const fieldPathWriteSource = assertNativeJavaRewriterCompiles(fieldPathWriteCode, 'wire');
    assertCondition(
      fieldPathWriteSource.includes('TraceHooks.readFieldPathAtLine') &&
        fieldPathWriteSource.includes('TraceHooks.emitFieldPathWriteAtLine') &&
        fieldPathWriteSource.includes('new String[] { "head", "next" }') &&
        fieldPathWriteSource.includes('new String[] { "tail", "prev" }') &&
        fieldPathWriteSource.includes('new String[] { "next", "prev" }'),
      `Java nested field assignments should rewrite to field-path writes, received ${fieldPathWriteSource}`
    );
    console.log('PASS: java rewriter emits field-path writes for nested object assignments');

    await harness.sendMessage<{ success: boolean }>('execute-with-tracing', {
      code: `class Solution {
  public int legacySnapshot() {
    return 1;
  }
}`,
      functionName: 'legacySnapshot',
      inputs: {},
      executionStyle: 'function',
    });

    const legacySnapshotSource = latestSourceContaining(harness.stringFiles, 'TraceHooks.emitRuntimeSnapshotAtLine');
    assertCondition(
      !legacySnapshotSource.includes('emitListStateAtLine') &&
        !legacySnapshotSource.includes('emitTreeStateAtLine') &&
        !legacySnapshotSource.includes('emitObjectStateAtLine') &&
        legacySnapshotSource.includes('TraceHooks.emitRuntimeSnapshotAtLine(5, "box", box);'),
      'Java worker should receive neutral runtime snapshot hooks from the rewriter'
    );
    console.log('PASS: java worker receives runtime snapshot hooks from the rewriter');

    let invalidRejected = false;
    try {
      await harness.sendMessage('execute-code', {
        code: 'result = 1;',
        functionName: '',
        inputs: {},
        executionStyle: 'solution-method',
      });
    } catch (error) {
      invalidRejected =
        error instanceof Error &&
        error.message.includes('script-mode execution only supports executionStyle="function"');
    }
    assertCondition(invalidRejected, 'Java script mode should reject non-function execution styles');
    console.log('PASS: java script mode rejects non-function execution style');
  } finally {
    harness.terminate();
  }

  console.log('\nJava runtime worker tests passed.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
