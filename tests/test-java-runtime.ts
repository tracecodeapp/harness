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
    console.log('PASS: Java native mutation hooks emit post-line snapshots');
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
    enhancedForArraySource.includes('for (Object[] account : accounts) {') &&
      enhancedForArraySource.includes('TraceHooks.readObjectArrayAtLine(5, "account", account, 0, null)') &&
      enhancedForArraySource.includes('TraceHooks.readObjectArrayAtLine(7, "account", account, i, "i")'),
    'Java rewriter should register enhanced-for array aliases before instrumenting indexed reads from them'
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
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timeoutId: ReturnType<typeof setTimeout> }
  >();
  const rewriteCalls: RewriteCall[] = [];
  const stringFiles: Array<{ path: string; source: string }> = [];
  const runLibraryClasspaths: string[] = [];
  let nextId = 0;

  const selfObject: {
    postMessage: (message: WorkerMessage) => void;
    onmessage: ((event: { data: WorkerMessage }) => void) | null;
    importScripts: (...urls: string[]) => void;
    cheerpjInit: () => Promise<void>;
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
      pending.delete(id);
      clearTimeout(entry.timeoutId);
      if (message.type === 'error') {
        const payload = message.payload as { error?: unknown } | undefined;
        entry.reject(new Error(String(payload?.error ?? 'Worker error')));
        return;
      }
      entry.resolve(message.payload);
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
    cheerpjInit: async () => {},
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
    console,
    self: selfObject,
    performance: { now: () => Date.now() },
    setTimeout,
    clearTimeout,
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
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeoutId });
    });

    onmessage?.({ data: { id, type, payload } });
    return responsePromise;
  }

  function terminate(): void {
    onmessage?.({ data: { type: 'terminate' } });
  }

  return { rewriteCalls, runLibraryClasspaths, sendMessage, stringFiles, terminate };
}

async function main(): Promise<void> {
  testJavaHelperJarDoesNotExposeDeprecatedSpikePackages();
  testNativeJavaRewriterRegressionGaps();
  testJavaRuntimeValueSerializationLimit();
  testJavaRuntimeMultiSnapshotFragments();
  testJavaRuntimeRecursiveCallStacks();
  testJavaRuntimeMutationHooksEmitPostSnapshots();

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
    assertCondition(
      graphSource.includes('TraceHooks.readObjectListAtLine(7, "graph", graph, 0, null).add(1);') &&
        graphSource.includes('TraceHooks.emitMutatingCallAtLine(7, "graph", 0, "add", null, 1);') &&
        !graphSource.includes('emit' + 'Graph' + 'AdjacencyStateAtLine'),
      'Java worker should rewrite indexed adjacency mutations with receiver indices without semantic graph state'
    );
    assertCondition(
      graphSource.includes('for (int v : TraceHooks.readObjectListAtLine(11, "graph", graph, u, "u"))'),
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
