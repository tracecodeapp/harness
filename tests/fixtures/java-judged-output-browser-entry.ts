import { createAlgorithmJudgeBundle } from '../../src/judge';
import { createBrowserRuntimeHost } from '../../packages/runtime-browser/src/browser-runtime-host';
import { createBrowserRuntimeProviderRegistry } from '../../packages/runtime-browser/src/runtime-provider-registry';
import { createJavaBrowserRuntimeProvider } from '../../packages/runtime-java/src/browser-runtime-provider';
import { JavaWorkerClient } from '../../packages/runtime-java/src/java-worker-client';
import type { JudgedOutputPolicy, JudgedPreparationCall } from '../../packages/runtime-contracts/src/judged-output-policy';
import { createBrowserJudgeHostFromRuntimeHost } from '../../src/internal/browser-judge';

const bridge = Symbol.for('@tracecode/harness/internal/judge-test-bridge/v1');
const workerUrl = '/workers/java-runtime-worker.js';
const code = `class AnswerNode {
  int val = 7;
  AnswerNode next;
}
class Solution {
  public Object solve(String mode, int n) {
    switch (mode) {
      case "ascii": return "x".repeat(n);
      case "snow": return "\\u96ea".repeat(n);
      case "emoji": return "\\ud83d\\ude00".repeat(n);
      case "lone": return "\\ud800".repeat(n);
      case "depth":
        Object answer = 7;
        for (int i = 0; i < n; i++) answer = new Object[] {answer};
        return answer;
      case "map-depth":
        Object map = 7;
        for (int i = 0; i < n; i++) map = java.util.Map.of("next", map);
        return map;
      case "set-depth":
        Object set = 7;
        for (int i = 0; i < n; i++) set = java.util.Collections.singleton(set);
        return set;
      case "list-depth":
        Object list = 7;
        for (int i = 0; i < n; i++) list = java.util.List.of(list);
        return list;
      case "map-keys":
        java.util.Map<Object, Integer> keys = new java.util.LinkedHashMap<>();
        keys.put(1, 6);
        keys.put("1", 7);
        return keys;
      case "items": return new char[n];
      case "rows": return java.util.List.of(java.util.List.of(1, 2), java.util.List.of(3, 4));
      case "cycle":
        Object[] cycle = new Object[1];
        cycle[0] = cycle;
        return cycle;
      case "node-cycle":
        AnswerNode node = new AnswerNode();
        node.next = node;
        return node;
      case "shared":
        Object[] row = new Object[] {1};
        return new Object[] {row, row};
      default: return n;
    }
  }
}`;
const method = { code, functionName: 'solve', executionStyle: 'solution-method' as const };
const input = (mode: string, n: number) => ({ mode, n });
const testCase = (id: string, mode: string, n: number, expected: unknown) => ({
  id, input: input(mode, n), expected,
});
const nested = (n: number) => Array.from({ length: n }).reduce<unknown>((value) => [value], 7);

async function runJavaJudgedOutputPolicy() {
  const markers: unknown[] = [];
  const groups = [
    {
      id: 'bytes', lower: { maxBytes: 1024 }, cases: [
        testCase('ascii-64', 'ascii', 64, 'x'.repeat(64)),
        testCase('ascii-2048', 'ascii', 2048, 'x'.repeat(2048)),
        testCase('ascii-edge', 'ascii', 1022, 'x'.repeat(1022)),
        testCase('snow-over', 'snow', 341, '雪'.repeat(341)),
        testCase('emoji-edge', 'emoji', 255, '😀'.repeat(255)),
        testCase('emoji-over', 'emoji', 256, '😀'.repeat(256)),
        testCase('lone-over', 'lone', 171, '\ud800'.repeat(171)),
      ],
    },
    {
      id: 'shape', lower: { maxItems: 2, maxNodes: 65 }, cases: [
        testCase('depth-64', 'depth', 64, nested(64)),
        testCase('depth-65', 'depth', 65, nested(65)),
        testCase('item-over', 'items', 3, []),
        testCase('per-container', 'rows', 0, [[1, 2], [3, 4]]),
        testCase('cycle', 'cycle', 0, []),
        testCase('shared', 'shared', 0, []),
      ],
    },
    {
      id: 'nodes', lower: { maxNodes: 6 }, cases: [
        testCase('node-over', 'rows', 0, [[1, 2], [3, 4]]),
        testCase('node-edge', 'depth', 5, nested(5)),
      ],
    },
    {
      id: 'language-depth', lower: {}, cases: [
        testCase('map-depth-64', 'map-depth', 64,
          Array.from({ length: 64 }).reduce<unknown>((value) => ({ next: value }), 7)),
        testCase('map-depth-65', 'map-depth', 65, 7),
        testCase('set-depth-64', 'set-depth', 64,
          Array.from({ length: 64 }).reduce<unknown>((value) => ({ __type__: 'set', values: [value] }), 7)),
        testCase('set-depth-65', 'set-depth', 65, 7),
        testCase('list-depth-64', 'list-depth', 64, nested(64)),
        testCase('list-depth-65', 'list-depth', 65, 7),
      ],
    },
    {
      id: 'json-items', lower: { maxItems: 1 }, cases: [
        testCase('map-key-collision', 'map-keys', 0, { 1: 7 }),
        testCase('set-wrapper-items', 'set-depth', 1, 7),
      ],
    },
    {
      id: 'json-nodes', lower: { maxNodes: 3 }, cases: [
        testCase('set-wrapper-nodes', 'set-depth', 1, 7),
      ],
    },
    {
      id: 'lowered-depth', lower: { maxDepth: 0 }, cases: [
        testCase('scalar-root', 'number', 7, 7),
        testCase('container-root', 'depth', 1, [7]),
      ],
    },
    {
      id: 'reference-encoded', lower: {}, cases: [
        testCase('node-cycle', 'node-cycle', 0, {
          __type__: 'AnswerNode', __id__: 'node', val: 7, next: { __ref__: 'node' },
        }),
      ],
    },
  ];
  let lower: Partial<JudgedOutputPolicy> | undefined;
  Object.defineProperty(globalThis, bridge, {
    configurable: true,
    value: {
      onEvent(event: { phase: string }) {
        if (event.phase === 'judged-output-policy') markers.push(event);
      },
      judgedOutputPolicy({ language }: { language: string }) {
        return language === 'java' ? lower : undefined;
      },
    },
  });
  const host = createBrowserJudgeHostFromRuntimeHost(createBrowserRuntimeHost({
    assetBaseUrl: '/workers',
    assets: { javaWorker: workerUrl },
    providers: ['java'],
    providerRegistry: createBrowserRuntimeProviderRegistry([
      createJavaBrowserRuntimeProvider({ runtimeAssetBaseUrl: '/tracejvm/' }),
    ]),
  }));
  const client = new JavaWorkerClient({ workerUrl: workerUrl + '?tracejvmBaseUrl=/tracejvm/' });
  try {
    const rows = [];
    for (const group of groups) {
      lower = group.lower;
      const bundle = await createAlgorithmJudgeBundle({
        ...method, language: 'java', id: 'java-judged-' + group.id, cases: group.cases,
      });
      const receipt = await host.evaluateAlgorithm({ bundle });
      rows.push(...receipt.evaluation.cases.map((row) => ({
        id: row.caseId, verdict: row.verdict.kind, status: row.status,
        failure: row.failure, hasValue: row.value !== undefined && row.value !== null,
        ...(row.caseId === 'node-cycle' ? { value: row.value } : {}),
      })));
    }

    const judgedOutputPolicy = { maxBytes: 1024, maxItems: 250_000, maxNodes: 1_000_000, maxDepth: 64 };
    const legacy = await client.prepareRuntimeProgram({ ...method, mode: 'code' });
    if (!legacy.success || !legacy.programId) throw new Error(legacy.error);
    const legacyNode = await client.executePreparedCode(legacy.programId, {
      inputs: input('node-cycle', 0),
    });
    await client.disposePreparedRuntimeProgram(legacy.programId);

    const call: JudgedPreparationCall = { ...method, mode: 'code', judgedOutputPolicy };
    const prepared = await client.prepareRuntimeProgram(call);
    if (!prepared.success || !prepared.programId) throw new Error(prepared.error);
    const batch = await client.executePreparedCodeBatch(prepared.programId, {
      inputBatch: [input('cycle', 0), input('ascii', 64)],
      stopAtFirstRunaway: true,
    });
    if (!prepared.snapshot) throw new Error('Missing prepared Java artifact');
    await client.disposePreparedRuntimeProgram(prepared.programId);
    const restored = await client.restorePreparedRuntimeProgram(prepared.snapshot);
    if (!restored.success || !restored.programId) throw new Error(restored.error);
    const restoredResult = await client.executePreparedCode(restored.programId, {
      inputs: input('ascii', 2048),
    });
    await client.disposePreparedRuntimeProgram(restored.programId);

    const opsCall: JudgedPreparationCall = {
      mode: 'code',
      code: 'class Counter { public Object value() { return new int[] {1, 2, 3}; } }',
      functionName: 'Counter',
      executionStyle: 'ops-class',
      judgedOutputPolicy: { ...judgedOutputPolicy, maxItems: 2 },
    };
    const ops = await client.prepareRuntimeProgram(opsCall);
    if (!ops.success || !ops.programId) throw new Error(ops.error);
    const opsResult = await client.executePreparedCode(ops.programId, {
      inputs: { operations: ['Counter', 'value'], arguments: [[], []] },
    });
    return { rows, markers, legacyNode, batch, profile: prepared.algorithmIsolationProfile, restoredResult, opsResult };
  } finally {
    client.terminate();
    host.dispose();
    Reflect.deleteProperty(globalThis, bridge);
  }
}

declare global {
  var javaJudgedOutputProbe: typeof runJavaJudgedOutputPolicy;
}
globalThis.javaJudgedOutputProbe = runJavaJudgedOutputPolicy;
