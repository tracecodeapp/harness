// Browser entry for tests/test-javascript-judged-output-browser.ts (lane C-SEAM).
// Every evaluation goes through the public Judge host, so the policy reaches
// the worker only the way the product sends it: on the ordinary prepare.
import { createAlgorithmJudgeBundle } from '../../packages/judge/src/algorithm-bundle';
import { createBrowserRuntimeHost } from '../../packages/runtime-browser/src/browser-runtime-host';
import { createBrowserRuntimeProviderRegistry } from '../../packages/runtime-browser/src/runtime-provider-registry';
import { createJavaScriptBrowserRuntimeProvider } from '../../packages/runtime-javascript/src/browser-runtime-provider';
import { createBrowserJudgeHostFromRuntimeHost } from '../../src/internal/browser-judge';

type Execution = 'ses-compartment-pool' | 'disposable-worker';
type Language = 'javascript' | 'typescript';

const BRIDGE = Symbol.for('@tracecode/harness/internal/judge-test-bridge/v1');
const DEFAULT_BYTES = 8 * 1024 * 1024;

const SOURCE = {
  javascript: `class ListNode { constructor(val, next = null) { this.val = val; this.next = next; } }
function solve(mode, n) {
  if (mode === 'ascii') return 'x'.repeat(n);
  if (mode === 'snow') return '雪'.repeat(n);
  if (mode === 'list') { let head = null; for (let i = n; i > 0; i -= 1) head = new ListNode(i, head); return head; }
  if (mode === 'cycle') { const a = [n]; a.push(a); return a; }
  if (mode === 'shared') { const row = [1, 2]; return [[row, row], new Array(3).fill([])]; }
  return n;
}`,
  typescript: `class ListNode { val: number; next: ListNode | null; constructor(val: number, next: ListNode | null = null) { this.val = val; this.next = next; } }
function solve(mode: string, n: number): unknown {
  if (mode === 'ascii') return 'x'.repeat(n);
  if (mode === 'snow') return '雪'.repeat(n);
  if (mode === 'list') { let head: ListNode | null = null; for (let i = n; i > 0; i -= 1) head = new ListNode(i, head); return head; }
  if (mode === 'cycle') { const a: unknown[] = [n]; a.push(a); return a; }
  if (mode === 'shared') { const row = [1, 2]; return [[row, row], new Array(3).fill([])]; }
  return n;
}`,
} as const;

function expectedList(length: number): unknown {
  let head: unknown = null;
  for (let index = length; index > 0; index -= 1) {
    head = { __type__: 'ListNode', __id__: `ref-${index}`, val: index, next: head };
  }
  return head;
}

function installBridge(lower: () => Record<string, number> | undefined, events: unknown[]) {
  Object.defineProperty(globalThis, BRIDGE, {
    configurable: true,
    value: {
      onEvent(event: unknown) { events.push(event); },
      judgedOutputPolicy() { return lower(); },
    },
  });
}

async function runOne(assetBaseUrl: string, language: Language, execution: Execution, lowered: boolean) {
  const events: unknown[] = [];
  installBridge(() => (lowered ? { maxBytes: 1024 } : undefined), events);
  const runtimeHost = createBrowserRuntimeHost({
    assetBaseUrl,
    providers: ['javascript', 'typescript'],
    providerRegistry: createBrowserRuntimeProviderRegistry([
      createJavaScriptBrowserRuntimeProvider({ algorithmExecution: execution }),
    ]),
    safeExecution: { workerLifecycle: 'retire-only' },
  });
  const host = createBrowserJudgeHostFromRuntimeHost(runtimeHost);
  try {
    const cases = lowered
      ? [
          { id: 'ascii-64', input: { mode: 'ascii', n: 64 }, expected: 'x'.repeat(64) },
          { id: 'ascii-2048', input: { mode: 'ascii', n: 2048 }, expected: 'x'.repeat(2048) },
          { id: 'ascii-1022', input: { mode: 'ascii', n: 1022 }, expected: 'x'.repeat(1022) },
          { id: 'ascii-1023', input: { mode: 'ascii', n: 1023 }, expected: 'x'.repeat(1023) },
          { id: 'snow-400', input: { mode: 'snow', n: 400 }, expected: '雪'.repeat(400) },
          { id: 'after-refusal', input: { mode: 'number', n: 7 }, expected: 7 },
        ]
      : [
          { id: 'default-under', input: { mode: 'ascii', n: DEFAULT_BYTES - 2 }, expected: 'x'.repeat(DEFAULT_BYTES - 2) },
          { id: 'default-over', input: { mode: 'ascii', n: DEFAULT_BYTES - 1 }, expected: 'over' },
          { id: 'list-64', input: { mode: 'list', n: 64 }, expected: expectedList(64) },
          { id: 'list-65', input: { mode: 'list', n: 65 }, expected: expectedList(65) },
          { id: 'cycle', input: { mode: 'cycle', n: 1 }, expected: [1] },
          { id: 'shared', input: { mode: 'shared', n: 0 }, expected: [[[1, 2], [1, 2]], [[], [], []]] },
          { id: 'after-refusal', input: { mode: 'number', n: 7 }, expected: 7 },
        ];
    const bundle = await createAlgorithmJudgeBundle({
      id: `judged-output-${language}-${execution}-${lowered ? 'seam' : 'default'}`,
      language,
      code: SOURCE[language],
      functionName: 'solve',
      cases,
    });
    const receipt = await host.evaluateAlgorithm({ bundle });
    const rows = receipt.evaluation.status === 'completed' ? receipt.evaluation.cases : [];
    return {
      language,
      execution,
      lowered,
      evaluationStatus: receipt.evaluation.status,
      rows: rows.map((row) => ({
        id: row.caseId,
        status: row.status,
        verdict: row.verdict.kind,
        failure: row.failure ? { origin: row.failure.origin, reason: 'reason' in row.failure ? row.failure.reason : undefined } : undefined,
        hasValue: row.value !== undefined && row.value !== null,
        valueBytes: row.value === undefined ? 0 : JSON.stringify(row.value).length,
        fastBatch: row.timings?.algorithmFastBatch === true,
      })),
      markers: events.filter((event) => (event as { phase?: string }).phase === 'judged-output-policy'),
    };
  } finally {
    host.dispose();
    Reflect.deleteProperty(globalThis, BRIDGE);
  }
}

export async function runJavaScriptJudgedOutputPolicy(assetBaseUrl: string) {
  const results = [];
  for (const language of ['javascript', 'typescript'] as const) {
    for (const execution of ['ses-compartment-pool', 'disposable-worker'] as const) {
      for (const lowered of [true, false]) {
        results.push(await runOne(assetBaseUrl, language, execution, lowered));
      }
    }
  }
  return results;
}
