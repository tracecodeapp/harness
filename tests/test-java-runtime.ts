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
  let nextId = 0;

  const selfObject: {
    postMessage: (message: WorkerMessage) => void;
    onmessage: ((event: { data: WorkerMessage }) => void) | null;
    importScripts: (...urls: string[]) => void;
    cheerpjInit: () => Promise<void>;
    cheerpOSAddStringFile: (path: string, source: string) => Promise<void>;
    cheerpjRunLibrary: () => Promise<unknown>;
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
    cheerpjRunLibrary: async () => ({
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
                    nativeJavaEvent({ kind: 'mutate', line: 6, target: { variable: 'graph', path: [0] }, method: 'append' }),
                    nativeJavaEvent({ kind: 'snapshot', line: 6, target: { variable: 'graph' }, value: [[1], [], []] }),
                    nativeJavaEvent({ kind: 'read', line: 7, target: { variable: 'graph', path: [1] }, value: [] }),
                    nativeJavaEvent({ kind: 'mutate', line: 7, target: { variable: 'graph', path: [1] }, method: 'append' }),
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
                    nativeJavaEvent({ kind: 'mutate', line: 8, function: 'solve', target: { variable: 'this', path: ['values'] }, method: 'append' }),
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
    values.add(n); TraceHooks.emit("trace:{\\"kind\\":\\"mutate\\",\\"line\\":8,\\"target\\":{\\"variable\\":\\"this\\",\\"path\\":[\\"values\\"]},\\"method\\":\\"append\\"}");
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
    }),
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

  return { rewriteCalls, sendMessage, stringFiles, terminate };
}

async function main(): Promise<void> {
  testNativeJavaRewriterRegressionGaps();

  const workerSource = await loadWorkerSource();
  const augmentationSource = await loadJavaSourceAugmentationSource();
  const harness = createWorkerHarness(workerSource, augmentationSource);

  try {
    const init = await harness.sendMessage<{ success: boolean; loadTimeMs: number }>('init');
    assertCondition(init.success === true, 'Init should succeed');
    console.log('PASS: java worker init with mocked CheerpJ bridge');

    const scriptCode = `import java.util.HashMap;
import java.util.Map;

Map<Integer, Integer> seen = new HashMap<>();
result = new int[] { 0, 1 };`;

    const execute = await harness.sendMessage<{
      success: boolean;
      output: unknown;
      events?: string[];
      sourceText?: string;
    }>('execute-code', {
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
    }>('execute-code', {
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
    }>('execute-code', {
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

    const lowerBoundExecute = await harness.sendMessage<{ success: boolean; error?: string }>('execute-code', {
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

    await harness.sendMessage<{ success: boolean }>('execute-code', {
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
    }>('execute-code', {
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
      file: 'Solution.java',
    });
    assertCondition(
      graphTrace.events.some((event) =>
        event.kind === 'mutate' &&
        'variable' in event.target &&
        event.target.variable === 'graph' &&
        event.method === 'append' &&
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
      file: 'Solution.java',
    });
    assertCondition(
      fieldListTrace.events.some((event) =>
        event.kind === 'mutate' &&
        'variable' in event.target &&
        event.target.variable === 'this' &&
        event.method === 'append' &&
        'path' in event.target &&
        JSON.stringify(event.target.path) === JSON.stringify(['values'])
      ),
      'Java field collection mutations should emit this-field mutate runtime events'
    );
    console.log('PASS: java worker rewrites field collection mutations as this-field runtime trace events');

    await harness.sendMessage<{ success: boolean }>('execute-code', {
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
