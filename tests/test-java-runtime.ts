#!/usr/bin/env npx tsx

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { javaTraceHooksEventsToRuntimeTrace } from '../packages/harness-core/src/trace-adapters/java';

interface WorkerMessage {
  id?: string;
  type: string;
  payload?: unknown;
}

interface RewriteCall {
  source: string;
  executionStyle: string;
  entryName: string;
  exportsSource: string;
  exportsClassName: string;
  packageName: string;
}

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

function assertJavaSourceCompiles(source: string, label: string): void {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'tracecode-java-source-compile-'));
  try {
    const publicClassName = source.match(/\bpublic\s+class\s+([A-Za-z_][A-Za-z0-9_]*)/)?.[1] ?? 'Main';
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
    Map<String, Integer> map = new LinkedHashMap<>();
    for (int i = 0; i < 70; i++) map.put(String.valueOf(i), i);
    System.out.println(TraceHooks.serializeResult(values));
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
    const [listJson, mapJson, outputListJson] = output.trim().split('\n');
    assertCondition(
      listJson.endsWith(',{"__truncated__":true,"remaining":6}]'),
      'Java large lists should serialize first 64 items plus truncation marker'
    );
    assertCondition(
      mapJson.includes('"__truncated__":true,"remaining":6'),
      'Java large maps should serialize truncation fields'
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
import tracecode.browser.BrowserCompileAndTraceLibrary;

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
    const [isDirectory, changedFilesJson, kernelChangedFilesJson] = output.trim().split('\n');
    assertCondition(isDirectory === 'true', `Java browser helper should materialize workspace directories: ${output}`);
    assertCondition(
      Array.isArray(JSON.parse(changedFilesJson ?? 'null')) && JSON.parse(changedFilesJson ?? 'null').length === 0,
      'Java browser helper should not report directory manifest entries as file changes'
    );
    assertCondition(
      Array.isArray(JSON.parse(kernelChangedFilesJson ?? 'null')) && JSON.parse(kernelChangedFilesJson ?? 'null').length === 0,
      'Java browser helper should not report kernel virtual manifest entries as workspace deletions'
    );
    const projectEventsSource = readFileSync(
      join(process.cwd(), 'workers', 'java', 'src', 'tracecode', 'browser', 'ProjectEvents.java'),
      'utf8'
    );
    assertCondition(
      /ProjectFileOutputStream[\s\S]*super\.write\(value\);\s*emitFileSnapshot\(path\);/.test(projectEventsSource) &&
        /ProjectFileOutputStream[\s\S]*super\.write\(bytes\);\s*emitFileSnapshot\(path\);/.test(projectEventsSource) &&
        /ProjectOutputStream[\s\S]*delegate\.write\(bytes, offset, length\);\s*emitFileSnapshot\(path\);/.test(projectEventsSource),
      'Java browser helper should emit live file snapshots from unbuffered file stream writes'
    );
    console.log('PASS: Java browser helper materializes workspace directories');
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
    workspaceManifest?: string;
    workspaceRoot?: string;
    workspaceCwd?: string;
  }> = [];
  const runLibraryClasspaths: string[] = [];
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
      if (message.type === 'project-event') {
        entry.events.push(message.payload);
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
              const stdout = `after-filewriter-live\n5\njava_args=alpha,beta\njava_stdin=from-stdin\n${hasKernelProc ? 'proc-info\nproc-stream=tracekernel test\nproc-write:IOException\nproc-list=info,version\n' : ''}${hasKernelDevices ? 'dev-list=stderr,stdin,stdout,tty\ndev-stream=stderr,stdin,stdout,tty\ndev-glob=stderr,stdin,stdout\ndev-filter=stderr,stdout\ndev-stat=true:true:true:false\ndev-delete:IOException\ndev_stdin=from-stdin\ndev_stream_stdin=from-stdin\ndev_stdout\nfos_stdout\ndev_tty\nfrom-stdin\nstdout-read:IOException\nstdout-stream-read:IOException\n' : ''}`;
              const stderr = hasKernelDevices ? 'dev_stderr\nps_stderr\n' : '';
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
              }
              if (hasKernelDevices) {
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  'dev-list=stderr,stdin,stdout,tty\n'
                );
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  'dev-stream=stderr,stdin,stdout,tty\n'
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
                  'dev_tty\n',
                  '/dev/tty'
                );
                cheerpjInitOptions?.natives?.Java_tracecode_browser_ProjectEvents_emitOutputNative?.(
                  null,
                  'stdout',
                  'from-stdin\n'
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
                  'stderr',
                  'dev_stderr\n'
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
                  { path: 'random.bin', contents: Buffer.from([0, 9, 8]).toString('base64'), encoding: 'base64' },
                  { path: 'classic-created.txt', contents: '', encoding: 'base64' },
                  { path: 'classic-renamed.txt', contents: Buffer.from('classic\n', 'utf8').toString('base64'), encoding: 'base64' },
                  { path: 'stdin-copy.txt', contents: Buffer.from('from-stdin\n', 'utf8').toString('base64'), encoding: 'base64' },
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
                  { path: 'app/Main.class', contents: 'yv66vg==', encoding: 'base64' },
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
              projectClassCompileCalls.push({ classManifest, mainClassName, runtimeClasspath });
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
              projectClassCompileCalls.push({ classManifest, mainClassName, runtimeClasspath, workspaceManifest, workspaceRoot, workspaceCwd });
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
      if (TraceHooks.readIntArrayAtLine(8, "nums", nums, mid) < target)
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
      int complement = target - TraceHooks.readIntArrayAtLine(7, "nums", nums, i);
      TraceHooks.emitLineAtLine(8);
      if (seen.containsKey(complement)) {
        TraceHooks.emitLineAtLine(9);
        int[] out = new int[] { seen.get(complement), i };
        TraceHooks.emitReturnAtLine(9, "twoSum");
        return out;
      }
      TraceHooks.emitLineAtLine(11);
      seen.put(TraceHooks.readIntArrayAtLine(11, "nums", nums, i), i);
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
    const responsePromise = new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        reject(new Error(`Timed out waiting for response: ${type}`));
      }, 5000);
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeoutId, events: [] });
    });

    onmessage?.({ data: { id, type, payload } });
    return responsePromise;
  }

  function terminate(): void {
    onmessage?.({ data: { type: 'terminate' } });
  }

  return { projectClassCompileCalls, projectCompileCalls, rewriteCalls, runLibraryClasspaths, sendMessage, stringFiles, terminate };
}

async function main(): Promise<void> {
  testNativeJavaRewriterRegressionGaps();
  testJavaRuntimeValueSerializationLimit();
  testJavaBrowserHelperWorkspaceDirectories();
  testJavaRuntimeMultiSnapshotFragments();

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
      files?: Array<{ path: string; contents?: string; encoding?: string; deleted?: true }>;
      events?: Array<{
        type: string;
        stream?: 'stdout' | 'stderr';
        device?: string;
        sourceDevice?: string;
        data?: string;
        phase?: string;
        change?: { path: string; contents?: string; encoding?: string; deleted?: true };
      }>;
    }>('execute-project-java', {
      code: '',
      source: 'run',
      scriptPath: 'Main',
      args: ['alpha', 'beta'],
      cwd: '/workspace',
      env: {},
      stdin: 'from-stdin\n',
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
              '    try (var stream = Files.newOutputStream(Path.of("nio-stream.bin"))) { stream.write(new byte[] { 0, (byte)252 }); }',
              '    try (var writer = Files.newBufferedWriter(Path.of("nio-writer.txt"))) { writer.write("nio-writer\\n"); }',
              '    try (var channel = Files.newByteChannel(Path.of("byte-channel.bin"), EnumSet.of(StandardOpenOption.CREATE, StandardOpenOption.WRITE, StandardOpenOption.TRUNCATE_EXISTING))) { channel.write(ByteBuffer.wrap(new byte[] { 0, 7, 6, 5 })); channel.truncate(3); }',
              '    try (var raf = new RandomAccessFile("random.bin", "rw")) { raf.write(new byte[] { 0, 1, 2, 3 }); raf.seek(1); raf.write(new byte[] { 9, 8 }); raf.setLength(3); }',
              '    new File("classic-created.txt").createNewFile();',
              '    try (var writer = new FileWriter("classic-rename-source.txt")) { writer.write("classic\\n"); }',
              '    new File("classic-rename-source.txt").renameTo(new File("classic-renamed.txt"));',
              '    new File("classic-delete.txt").createNewFile();',
              '    new File("classic-delete.txt").delete();',
              '    Files.copy(Path.of("/dev/stdin"), Path.of("stdin-copy.txt"), StandardCopyOption.REPLACE_EXISTING);',
              '    Files.copy(Path.of("stdin-copy.txt"), Path.of("/dev/stdout"), StandardCopyOption.REPLACE_EXISTING);',
              '    Files.deleteIfExists(Path.of("stale.txt"));',
              '    var liveWriter = new FileWriter("writer-before-output.txt");',
              '    liveWriter.write("before-output\\\\n");',
              '    System.out.println("after-filewriter-live");',
              '    liveWriter.close();',
              '    System.out.println(Helper.add(2, 3));',
              '    System.out.println("java_args=" + String.join(",", args));',
              '    System.out.println("java_stdin=" + new BufferedReader(new InputStreamReader(System.in)).readLine());',
              '    System.out.println(Files.readString(Path.of("/proc/kernel/info")).contains("tracekernel") ? "proc-info" : "proc-missing");',
              '    try (var stream = new FileInputStream("/proc/kernel/version")) { System.out.println("proc-stream=" + new String(stream.readAllBytes(), StandardCharsets.UTF_8).trim()); }',
              '    try { Files.writeString(Path.of("/proc/kernel/info"), "{}\\\\n"); System.out.println("proc-write:ok"); } catch (IOException ex) { System.out.println("proc-write:" + ex.getClass().getSimpleName()); }',
              '    try (var paths = Files.list(Path.of("/proc/kernel"))) { System.out.println("proc-list=" + paths.map(path -> path.getFileName().toString()).sorted().collect(Collectors.joining(","))); }',
              '    try (var paths = Files.list(Path.of("/dev"))) { System.out.println("dev-list=" + paths.map(path -> path.getFileName().toString()).sorted().collect(Collectors.joining(","))); }',
              '    try (var paths = Files.newDirectoryStream(Path.of("/dev"))) { var names = new java.util.ArrayList<String>(); for (var path : paths) names.add(path.getFileName().toString()); java.util.Collections.sort(names); System.out.println("dev-stream=" + String.join(",", names)); }',
              '    try (var paths = Files.newDirectoryStream(Path.of("/dev"), "std*")) { var names = new java.util.ArrayList<String>(); for (var path : paths) names.add(path.getFileName().toString()); java.util.Collections.sort(names); System.out.println("dev-glob=" + String.join(",", names)); }',
              '    try (var paths = Files.newDirectoryStream(Path.of("/dev"), path -> path.getFileName().toString().contains("out") || path.getFileName().toString().contains("err"))) { var names = new java.util.ArrayList<String>(); for (var path : paths) names.add(path.getFileName().toString()); java.util.Collections.sort(names); System.out.println("dev-filter=" + String.join(",", names)); }',
              '    System.out.println("dev-stat=" + Files.isDirectory(Path.of("/dev")) + ":" + Files.isRegularFile(Path.of("/dev/stdout")) + ":" + Files.exists(Path.of("/dev/stdin")) + ":" + Files.exists(Path.of("/dev/missing")));',
              '    try { Files.deleteIfExists(Path.of("/dev/stdout")); System.out.println("dev-delete:ok"); } catch (IOException ex) { System.out.println("dev-delete:" + ex.getClass().getSimpleName()); }',
              '    System.out.println("dev_stdin=" + Files.readString(Path.of("/dev/stdin")).trim());',
              '    try (var stream = new FileInputStream("/dev/stdin")) { System.out.println("dev_stream_stdin=" + new String(stream.readAllBytes(), StandardCharsets.UTF_8).trim()); }',
              '    Files.writeString(Path.of("/dev/stdout"), "dev_stdout\\\\n");',
              '    try (var stream = new FileOutputStream("/dev/stdout")) { stream.write("fos_stdout\\\\n".getBytes(StandardCharsets.UTF_8)); }',
              '    Files.writeString(Path.of("/dev/tty"), "dev_tty\\\\n");',
              '    Files.writeString(Path.of("/dev/stderr"), "dev_stderr\\\\n");',
              '    try (var stream = new PrintStream("/dev/stderr", "UTF-8")) { stream.print("ps_stderr\\\\n"); }',
              '    try { Files.readString(Path.of("/dev/stdout")); System.out.println("stdout-read:ok"); } catch (IOException ex) { System.out.println("stdout-read:" + ex.getClass().getSimpleName()); }',
              '    try { new FileInputStream("/dev/stdout").close(); System.out.println("stdout-stream-read:ok"); } catch (IOException ex) { System.out.println("stdout-stream-read:" + ex.getClass().getSimpleName()); }',
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
        ],
        kernelDevices: [
          { path: '/dev/stdin', readable: true, writable: false, inputDevice: '/dev/stdin' },
          { path: '/dev/stdout', readable: false, writable: true, outputDevice: '/dev/stdout' },
          { path: '/dev/stderr', readable: false, writable: true, outputDevice: '/dev/stderr' },
          { path: '/dev/tty', readable: true, writable: true, inputDevice: '/dev/stdin', outputDevice: '/dev/stdout' },
        ],
      },
    });
    assertCondition(projectExecute.exitCode === 0, 'Java execute-project-java should succeed');
    assertCondition(
      projectExecute.stdout === 'after-filewriter-live\n5\njava_args=alpha,beta\njava_stdin=from-stdin\nproc-info\nproc-stream=tracekernel test\nproc-write:IOException\nproc-list=info,version\ndev-list=stderr,stdin,stdout,tty\ndev-stream=stderr,stdin,stdout,tty\ndev-glob=stderr,stdin,stdout\ndev-filter=stderr,stdout\ndev-stat=true:true:true:false\ndev-delete:IOException\ndev_stdin=from-stdin\ndev_stream_stdin=from-stdin\ndev_stdout\nfos_stdout\ndev_tty\nfrom-stdin\nstdout-read:IOException\nstdout-stream-read:IOException\n',
      `Java execute-project-java should return captured stdout: ${JSON.stringify({ stdout: projectExecute.stdout, stderr: projectExecute.stderr })}`
    );
    assertCondition(projectExecute.stderr === 'dev_stderr\nps_stderr\n', 'Java execute-project-java should capture /dev/stderr writes');
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
            event.sourceDevice === '/dev/tty' &&
            event.data === 'dev_tty\n'
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
            event.data === 'stdout-read:IOException\n'
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
      defaultAdapterSource.includes('System.setIn(new java.io.ByteArrayInputStream("from-stdin\\n".getBytes("UTF-8")))'),
      'Java execute-project-java adapter should wire request stdin into System.in'
    );
    assertCondition(
      defaultAdapterSource.includes('ProjectEvents.setKernelDevices("') &&
        defaultAdapterSource.includes('L2Rldi9zdGRvdXQ='),
      'Java execute-project-java adapter should pass project kernelDevices into ProjectEvents'
    );
    assertCondition(
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.writeString(Path.of("generated.txt")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.readString(Path.of("/dev/stdin")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.list(Path.of("/dev")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.newDirectoryStream(Path.of("/dev")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.isDirectory(Path.of("/dev")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.isRegularFile(Path.of("/dev/stdout")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.exists(Path.of("/dev/stdin")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.writeString(Path.of("/dev/stdout")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('new tracecode.browser.ProjectEvents.ProjectFileWriter("writer.txt")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('new tracecode.browser.ProjectEvents.ProjectPrintWriter("printed.txt")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('new tracecode.browser.ProjectEvents.ProjectFileInputStream("/dev/stdin")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('new tracecode.browser.ProjectEvents.ProjectFileOutputStream("stream.bin")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('new tracecode.browser.ProjectEvents.ProjectFileOutputStream("/dev/stdout")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('new tracecode.browser.ProjectEvents.ProjectPrintStream("/dev/stderr"') === true &&
        defaultManifestEntries.get('Main.java')?.includes('new tracecode.browser.ProjectEvents.ProjectFile("classic-created.txt")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('new DataOutputStream(new tracecode.browser.ProjectEvents.ProjectFileOutputStream("data.bin")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.newByteChannel(Path.of("byte-channel.bin")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('new tracecode.browser.ProjectEvents.ProjectRandomAccessFile("random.bin", "rw")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.copy(Path.of("/dev/stdin"), Path.of("stdin-copy.txt")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.copy(Path.of("stdin-copy.txt"), Path.of("/dev/stdout")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.createFile(Path.of("nio-created.txt")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.newOutputStream(Path.of("nio-stream.bin")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.newBufferedWriter(Path.of("nio-writer.txt")') === true &&
        defaultManifestEntries.get('Main.java')?.includes('tracecode.browser.ProjectEvents.deleteIfExists(Path.of("stale.txt")') === true,
      'Java execute-project-java should route project source file mutations through the live event bridge'
    );
    assertCondition(
        defaultWorkspaceManifest.includes('Helper.java') &&
        defaultWorkspaceManifest.includes('Main.java') &&
        defaultWorkspaceManifest.includes('/proc/kernel/info\t') &&
        defaultWorkspaceManifest.includes('/proc/kernel/version\t') &&
        defaultWorkspaceManifest.includes('/proc/self/mountinfo\t') &&
        defaultWorkspaceManifest.includes('\tdir\tempty/child') &&
        harness.projectCompileCalls.at(-1)?.workspaceRoot?.endsWith('/workspace') &&
        harness.projectCompileCalls.at(-1)?.workspaceCwd?.endsWith('/workspace'),
      'Java execute-project-java should pass full project workspace files to the browser helper'
    );
    console.log('PASS: java worker executes project requests through a multifile compile path');

    await harness.sendMessage<{ stdout: string; stderr: string; exitCode: number }>('execute-project-java', {
      code: '',
      source: 'run',
      scriptPath: 'Main',
      args: [],
      cwd: '/workspace/src',
      env: {},
      stdin: '',
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
      stdin: '',
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
      stdin: '',
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
        jarClassCall.runtimeClasspath.endsWith('/classpath/app.jar') &&
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
      stdin: '',
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
      stdin: '',
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
        !jarCompileCall.compileClasspath.includes('/java-browser-helper.jar') &&
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
      stdin: '',
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
      stdin: '',
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
      stdin: '',
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
      stdin: '',
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
        !envClasspathCompileCall.compileClasspath.includes('/java-browser-helper.jar') &&
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
      stdin: '',
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
      stdin: '',
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
      stdin: '',
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
      stdin: '',
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
      stdin: '',
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
      stdin: '',
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
        classpathCall.runtimeClasspath.endsWith('/classpath/out') &&
        classpathCall.workspaceManifest?.includes('src/app/Main.java') &&
        classpathCall.workspaceRoot?.endsWith('/workspace'),
      'Java execute-project-java should use persisted class files for explicit classpath runs'
    );
    console.log('PASS: java worker runs explicit project classpath requests from persisted class files');

    const envClasspathProjectExecute = await harness.sendMessage<{ stdout: string; stderr: string; exitCode: number }>('execute-project-java', {
      code: '',
      source: 'run',
      scriptPath: 'app.Main',
      args: ['gamma'],
      cwd: '/workspace',
      env: { CLASSPATH: '/workspace/out' },
      stdin: '',
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
        envClasspathCall.runtimeClasspath.endsWith('/classpath/out') &&
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
      stdin: '',
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
      stdin: '',
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
    assertCondition(
      lowerBoundSource.includes(
        'TraceHooks.emitLineAtLine(8, "" + " nums=" + TraceHooks.serializeResult(nums) + " target=" + TraceHooks.serializeResult(target) + " left=" + TraceHooks.serializeResult(left) + " right=" + TraceHooks.serializeResult(right) + " mid=" + TraceHooks.serializeResult(mid));'
      ),
      'Java rewritten line hooks should emit visible method args and loop locals before indexed reads'
    );
    assertCondition(
      lowerBoundSource.includes('int __tracecodeReturnValue0 = left;') &&
        lowerBoundSource.includes(
          'TraceHooks.emitReturnAtLine(11, "lowerBound", __tracecodeReturnValue0);'
        ) &&
        lowerBoundSource.includes('return __tracecodeReturnValue0;'),
      'Java rewritten return hooks should emit serialized return values like JS/Python'
    );
    console.log('PASS: java worker augments rewritten call hooks and return hooks with live snapshots');

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
      twoSumSource.includes('TraceHooks.containsMapKeyAtLine(8, "seen", seen, complement)'),
      'Java worker should rewrite Map.containsKey into keyed TraceHooks access'
    );
    assertCondition(
      twoSumSource.includes('TraceHooks.readMapAtLine(9, "seen", seen, complement)'),
      'Java worker should rewrite Map.get into keyed TraceHooks read'
    );
    assertCondition(
      twoSumSource.includes('TraceHooks.writeMapAtLine(11, "seen", seen, TraceHooks.readIntArrayAtLine(11, "nums", nums, i), i);'),
      'Java worker should rewrite Map.put into keyed TraceHooks write while preserving argument instrumentation'
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

    const defaultMapCode = `import java.util.*;

class Solution {
  public int solve(int[] nums) {
    Map<Integer, Integer> freq = new HashMap<>();
    freq.put(1, freq.getOrDefault(1, 0) + 1);
    return freq.get(1);
  }
}`;

    await harness.sendMessage<{ success: boolean }>('execute-with-tracing', {
      code: defaultMapCode,
      functionName: 'solve',
      inputs: { nums: [1] },
      executionStyle: 'function',
    });

    const defaultMapSource = latestSourceContaining(harness.stringFiles, 'TraceHooks.readMapOrDefaultAtLine');
    assertCondition(
      defaultMapSource.includes('TraceHooks.readMapOrDefaultAtLine(6, "freq", freq, 1, 0)'),
      'Java worker should rewrite Map.getOrDefault into keyed TraceHooks get access'
    );
    assertCondition(
      defaultMapSource.includes('TraceHooks.writeMapAtLine(6, "freq", freq, 1, TraceHooks.readMapOrDefaultAtLine(6, "freq", freq, 1, 0) + 1);'),
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
    assertCondition(
      graphSource.includes('TraceHooks.readObjectListAtLine(7, "graph", graph, 0).add(1);') &&
        graphSource.includes('TraceHooks.emitMutatingCallAtLine(7, "graph", 0, "add");') &&
        !graphSource.includes('emit' + 'Graph' + 'AdjacencyStateAtLine'),
      'Java worker should rewrite indexed adjacency mutations with receiver indices without semantic graph state'
    );
    assertCondition(
      graphSource.includes('for (int v : TraceHooks.readObjectListAtLine(11, "graph", graph, u))'),
      'Java worker should rewrite adjacency traversal graph.get(u) reads'
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
        JSON.stringify(event.target.path) === JSON.stringify([1])
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
