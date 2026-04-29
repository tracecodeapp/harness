#!/usr/bin/env npx tsx

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';
import { buildJavaExecutionResult } from '../packages/harness-core/src/trace-adapters/java';

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

async function loadWorkerSource(): Promise<string> {
  const workerPath = join(process.cwd(), 'workers', 'java', 'java-worker.js');
  return readFile(workerPath, 'utf8');
}

async function loadJavaSourceAugmentationSource(): Promise<string> {
  const helperPath = join(process.cwd(), 'workers', 'java', 'java-source-augmentations.cjs');
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
        if (String(url).endsWith('java-source-augmentations.cjs')) {
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
      spike: {
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
                    'line=15 call __tracecodeScript',
                    'line=16',
                    'line=4 call uniquePaths rows=3 cols=4',
                    'line=5',
                    'line=8',
                    'line=9',
                    'line=10',
                    'line=10 write-array dp[1][1]=2',
                    'line=10 dp=[[1,1,1,1],[1,2,0,0],[1,0,0,0]]',
                    'line=10',
                    'line=10 write-array dp[1][2]=3',
                    'line=10 dp=[[1,1,1,1],[1,2,3,0],[1,0,0,0]]',
                    'line=9',
                    'line=10',
                    'line=10 write-array dp[2][1]=3',
                    'line=10 dp=[[1,1,1,1],[1,2,3,4],[1,3,0,0]]',
                    'line=13 return uniquePaths',
                    'line=17',
                    'line=17 return __tracecodeScript',
                  ],
                });
              }
              if (latestSource.includes('buildGraph')) {
                return JSON.stringify({
                  success: true,
                  output: JSON.stringify([0, 1, 2]),
                  events: [
                    'line=4 call buildGraph n=3',
                    'line=5 graph=[[],[],[]]',
                    'line=5 state graph-adjacency graph=[[],[],[]]',
                    'line=6 access graph[0]=[]',
                    'line=6 mutate-indexed graph[0] method=add',
                    'line=6 graph=[[1],[],[]]',
                    'line=7 access graph[1]=[]',
                    'line=7 mutate-indexed graph[1] method=add',
                    'line=7 graph=[[1],[2],[]]',
                    'line=10 access graph[0]=[1]',
                    'line=10',
                    'line=11 access graph[1]=[2]',
                    'line=11',
                    'line=13 return buildGraph value=[0,1,2]',
                  ],
                });
              }
              return JSON.stringify({
                success: true,
                output: JSON.stringify([0, 1]),
                events: [
                  'line=1 call __tracecodeScript',
                  'line=2 seen={}',
                  'line=99 return __tracecodeScript',
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
import spike.user.TraceHooks;

class Solution {
  static int lowerBound(int[] nums, int target) {
    TraceHooks.emit("line=3 call lowerBound" + " target=" + target);
    TraceHooks.emit("line=4");
    int left = 0;
    TraceHooks.emit("line=4 left=" + left);
    TraceHooks.emit("line=5");
    int right = nums.length;
    TraceHooks.emit("line=5 right=" + right);
    TraceHooks.emit("line=6");
    while (left < right) {
      TraceHooks.emit("line=7");
      int mid = left + (right - left) / 2;
      TraceHooks.emit("line=7 mid=" + mid);
      TraceHooks.emit("line=8");
      if (TraceHooks.readIntArrayAtLine(8, "nums", nums, mid) < target)
        left = mid + 1;
      else
        right = mid;
    }
    TraceHooks.emit("line=11 return lowerBound");
    return left;
  }
}

${exportsSource.replace('public class Exports', `public class ${exportsClassName}`)}`;
              }
              if (source.includes('twoSum')) {
                return `package ${packageName};
import spike.user.TraceHooks;
import java.util.*;

class Solution {
  public int[] twoSum(int[] nums, int target) {
    TraceHooks.emit("line=4 call twoSum");
    TraceHooks.emit("line=5");
    Map<Integer, Integer> seen = new HashMap<>();
    TraceHooks.emit("line=6");
    for (int i = 0; i < nums.length; i++) {
      TraceHooks.emit("line=7");
      int complement = target - TraceHooks.readIntArrayAtLine(7, "nums", nums, i);
      TraceHooks.emit("line=8");
      if (seen.containsKey(complement)) {
        TraceHooks.emit("line=9");
        int[] out = new int[] { seen.get(complement), i };
        TraceHooks.emit("line=9 return twoSum");
        return out;
      }
      TraceHooks.emit("line=11");
      seen.put(TraceHooks.readIntArrayAtLine(11, "nums", nums, i), i);
      TraceHooks.emitMutatingCallAtLine(11, "seen", "put");
    }
    TraceHooks.emit("line=13 return twoSum");
    return new int[0];
  }
}

${exportsSource.replace('public class Exports', `public class ${exportsClassName}`)}`;
              }
              if (source.includes('buildGraph')) {
                return `package ${packageName};
import spike.user.TraceHooks;
import java.util.*;

class Solution {
  int[] buildGraph(int n) {
    TraceHooks.emit("line=4 call buildGraph");
    TraceHooks.emit("line=5");
    List<List<Integer>> graph = new ArrayList<>();
    TraceHooks.emit("line=6");
    for (int i = 0; i < n; i++) graph.add(new ArrayList<>());
    TraceHooks.emit("line=7");
    graph.get(0).add(1);
    TraceHooks.emitMutatingCallAtLine(7, "graph", "add");
    TraceHooks.emit("line=8");
    graph.get(1).add(2);
    TraceHooks.emitMutatingCallAtLine(8, "graph", "add");
    TraceHooks.emit("line=10");
    int[] order = new int[n];
    TraceHooks.emit("line=11");
    for (int u = 0; u < n; u++) {
      TraceHooks.emit("line=12");
      for (int v : graph.get(u)) {
        TraceHooks.emit("line=13");
        order[v] = v;
        TraceHooks.emitArrayWriteAtLine(13, "order", v, order[v]);
      }
    }
    TraceHooks.emit("line=16 return buildGraph");
    return order;
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
      Array.isArray(execute.events) && execute.events.some((event) => event.includes('call <module>')),
      'Java script trace events should expose <module> call events'
    );
    assertCondition(
      Array.isArray(execute.events) && execute.events.some((event) => event === 'line=5 return <module>'),
      'Java script return event should remap generated wrapper line to the last user line'
    );

    const scriptRewrite = harness.rewriteCalls.at(-1);
    assertCondition(Boolean(scriptRewrite), 'Java script request should call rewrite bridge');
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
        helperScriptExecute.events.includes('line=9 write-array dp[1][1]=2'),
      `Java helper script should remap helper body events to original source lines, got ${JSON.stringify(helperScriptExecute.events)}`
    );
    assertCondition(
      Array.isArray(helperScriptExecute.events) &&
        !helperScriptExecute.events.some((event) => event.startsWith('line=10 write-array')),
      'Java helper script should not leave helper body events on generated brace lines'
    );
    assertCondition(
      Array.isArray(helperScriptExecute.events) &&
        helperScriptExecute.events.includes('line=15 return <module>'),
      'Java helper script should remap generated script return to the top-level result line'
    );
    const helperEvents = Array.isArray(helperScriptExecute.events) ? helperScriptExecute.events : [];
    const repeatedInnerHeaderIndex = helperEvents.findIndex((event, index) =>
      event === 'line=8' && index > 0 && helperEvents[index - 1].startsWith('line=9 dp=')
    );
    assertCondition(
      repeatedInnerHeaderIndex > 0 && helperEvents[repeatedInnerHeaderIndex + 1] === 'line=9',
      `Java helper script should revisit the inner for line before repeated body iterations, got ${JSON.stringify(helperEvents)}`
    );
    const repeatedOuterHeaderIndex = helperEvents.findIndex((event, index) =>
      event === 'line=7' && index > 0 && helperEvents[index - 1].startsWith('line=9 dp=')
    );
    assertCondition(
      repeatedOuterHeaderIndex > 0 && helperEvents[repeatedOuterHeaderIndex + 1] === 'line=8',
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

    await harness.sendMessage<{ success: boolean }>('execute-code', {
      code: lowerBoundCode,
      functionName: '',
      inputs: {},
      executionStyle: 'function',
    });

    const lowerBoundSource = harness.stringFiles.at(-1)?.source ?? '';
    assertCondition(
      lowerBoundSource.includes(
        'TraceHooks.emit("line=3 call lowerBound" + " nums=" + TraceHooks.serializeResult(nums) + " target=" + TraceHooks.serializeResult(target));'
      ),
      'Java rewritten call hook should serialize all live method arguments like JS/Python trace call snapshots'
    );
    assertCondition(
      lowerBoundSource.includes('int right = TraceHooks.readArrayLengthAtLine(5, "nums", nums);'),
      'Java rewritten array length reads should emit runtime indexed-state context'
    );
    assertCondition(
      lowerBoundSource.includes(
        'TraceHooks.emit("line=8" + " nums=" + TraceHooks.serializeResult(nums) + " target=" + TraceHooks.serializeResult(target) + " left=" + TraceHooks.serializeResult(left) + " right=" + TraceHooks.serializeResult(right) + " mid=" + TraceHooks.serializeResult(mid));'
      ),
      'Java rewritten line hooks should emit visible method args and loop locals before indexed reads'
    );
    assertCondition(
      lowerBoundSource.includes('int __tracecodeReturnValue0 = left;') &&
        lowerBoundSource.includes(
          'TraceHooks.emit("line=11 return lowerBound value=" + TraceHooks.serializeResult(__tracecodeReturnValue0));'
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

    const twoSumSource = harness.stringFiles.at(-1)?.source ?? '';
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
        'TraceHooks.emit("line=7" + " nums=" + TraceHooks.serializeResult(nums) + " target=" + TraceHooks.serializeResult(target) + " seen=" + TraceHooks.serializeResult(seen) + " i=" + TraceHooks.serializeResult(i));'
      ),
      'Java worker should emit loop index locals on loop body line hooks'
    );
    console.log('PASS: java worker rewrites Map operations to keyed visualization hooks');

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

    const defaultMapSource = harness.stringFiles.at(-1)?.source ?? '';
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
    const graphSource = harness.stringFiles.at(-1)?.source ?? '';
    assertCondition(
      graphSource.includes('TraceHooks.readObjectListAtLine(7, "graph", graph, 0).add(1);') &&
        graphSource.includes('TraceHooks.emitMutatingCallAtLine(7, "graph", 0, "add");') &&
        graphSource.includes('TraceHooks.emitGraphAdjacencyStateAtLine(7, "graph", graph);'),
      'Java worker should rewrite indexed adjacency mutations with receiver indices and graph state'
    );
    assertCondition(
      graphSource.includes('for (int v : TraceHooks.readObjectListAtLine(11, "graph", graph, u))'),
      'Java worker should rewrite adjacency traversal graph.get(u) reads'
    );
    assertCondition(JSON.stringify(graphExecute.output) === JSON.stringify([0, 1, 2]), 'Java graph adjacency output should serialize result');
    assertCondition(
      Array.isArray(graphExecute.events) &&
        graphExecute.events.includes('line=5 state graph-adjacency graph=[[],[],[]]'),
      'Java graph adjacency runtime events should expose graph-adjacency state when emitted'
    );
    assertCondition(
      Array.isArray(graphExecute.events) &&
        graphExecute.events.includes('line=6 mutate-indexed graph[0] method=add') &&
        graphExecute.events.includes('line=7 mutate-indexed graph[1] method=add'),
      'Java graph adjacency runtime events should retain indexed receiver mutation indices'
    );

    const graphTrace = buildJavaExecutionResult(graphExecute.output, graphExecute.events ?? [], 0);
    assertCondition(
      graphTrace.trace.some((step) => step.visualization?.objectKinds?.graph === 'graph-adjacency'),
      'Java graph adjacency runtime events should normalize to objectKinds.graph-adjacency'
    );
    assertCondition(
      graphTrace.trace.some((step) =>
        step.accesses?.some((access) =>
          access.variable === 'graph' &&
          access.kind === 'mutating-call' &&
          access.method === 'add' &&
          JSON.stringify(access.indices) === JSON.stringify([1])
        )
      ),
      'Java graph adjacency runtime events should normalize indexed receiver mutations'
    );
    assertCondition(
      graphTrace.trace.some((step) =>
        step.accesses?.some((access) =>
          access.variable === 'graph' &&
          access.kind === 'indexed-read' &&
          JSON.stringify(access.indices) === JSON.stringify([0])
        )
      ),
      'Java graph adjacency traversal should normalize graph.get(u) reads'
    );
    console.log('PASS: java worker graph adjacency events normalize for visualization');

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
