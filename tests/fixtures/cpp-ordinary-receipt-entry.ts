import { Effect } from 'effect';
import type { BrowserRuntimeJudgeReceiptLease } from '../../packages/runtime-browser/src/browser-runtime-host-internal';
import { createBrowserRuntimeHost } from '../../packages/runtime-browser/src/browser-runtime-host';
import { createBrowserRuntimeProviderRegistry } from '../../packages/runtime-browser/src/runtime-provider-registry';
import { createAlgorithmJudgeBundle } from '../../packages/judge/src/algorithm-bundle';
import { createBrowserJudgeHost, createBrowserJudgeHostFromRuntimeHost } from '../../src/internal/browser-judge';
import type { JudgeCaseResult } from '../../packages/judge/src/model';
import { createCppOrdinaryExecutionProvider } from '../../packages/runtime-cpp/src/cpp-prepared-provider';
import {
  createCppObservationRegistration,
  createLegacyCppDrawingProducer,
  createSparseCppDrawingProducer,
  type CppDrawingProducer,
} from '../../packages/runtime-cpp/src/cpp-observation';
import { CppWorkerClient, type CppWorkerClientOptions } from '../../packages/runtime-cpp/src/cpp-worker-client';

import { createTraceCCRuntimeManifest } from '../../packages/runtime-cpp/src/tracecc-runtime-assets';

const endCharacter = `#include <string>
class Solution {
public:
 int solve(std::string s) {
   return int(s[s.size()]);
 }
};`;
const reference = (assertReference: boolean) => `#include <type_traits>
#include <vector>
class Solution {
public:
  int solve(std::vector<int>& nums) {
    auto& cur = nums[0];
    ${assertReference ? 'static_assert(std::is_reference_v<decltype(cur)>);' : ''}
    cur = 0;
    return nums[0];
  }
};`;

const fixtures = [
  { id: 'G1/cpp/end-character', code: endCharacter, inputs: [{ s: 'cat' }, { s: '' }], expected: [0, 0] },
  { id: 'G5/cpp/string-end', code: '#include <string>\nclass Solution { public: int solve(std::string s) { return int(s[s.size()]); } };',
    inputs: [{ s: 'cat' }, { s: '' }], expected: [0, 0] },
  { id: 'G5/cpp/trace-wrong', code: reference(false), inputs: [{ nums: [3] }, { nums: [5] }], expected: [0, 0] },
  { id: 'G5/cpp/trace-compile', code: reference(true), inputs: [{ nums: [3] }, { nums: [5] }], expected: [0, 0] },
  { id: 'G5/cpp/compound-assignment',
    code: '#include <vector>\nclass Solution {public: int solve(int n){std::vector<int> v{n}; v[0]*=1.5; return v[0];}};',
    inputs: [{ n: 3 }, { n: 5 }], expected: [4, 7] },
  { id: 'G5/cpp/step-cap',
    code: 'class Solution {\npublic:\n int solve(int n) {\n  int total = 0;\n  for (int i = 0; i < 20000; i++) {\n   total += i;\n  }\n  return n;\n }\n};',
    inputs: [{ n: 3 }, { n: 4 }], expected: [3, 4], maxTraceSteps: 2 },
  { id: 'G6/cpp/cpp-delete-alias',
    code: `#include <optional>
#include <string>
#include <unordered_map>

class KeyValueStore {
    std::unordered_map<std::string, int> store;

public:
    KeyValueStore() = default;

    void set(std::string key, int value) {
        store[key] = value;
    }

    std::optional<int> get(std::string key) {
        auto found = store.find(key);
        if (found == store.end()) return std::nullopt;
        return found->second;
    }

    bool deleteKey(std::string key) {
        return store.erase(key) > 0;
    }
};`,
    functionName: 'KeyValueStore', executionStyle: 'ops-class' as const,
    inputs: [{"operations": ["KeyValueStore", "set", "get", "delete", "get", "delete"], "arguments": [[], ["a", 1], ["a"], ["a"], ["a"], ["a"]]}, {"operations": ["KeyValueStore", "set", "get", "delete", "get", "delete"], "arguments": [[], ["b", 7], ["b"], ["c"], ["b"], ["b"]]}],
    expected: [[null, null, 1, true, null, false], [null, null, 7, false, 7, true]] },
];

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function assertCppOrdinaryReceiptPaths(options: CppWorkerClientOptions) {
  let throwObserverCompile = false;
  let thrownCompiles = 0;
  const requests: Array<{ role: string; mode?: string; traceEnabled?: boolean; traceOptions?: object }> = [];
  const createClient = (role: string) => {
    const client = new CppWorkerClient(options);
    const prepare = client.prepareRuntimeProgram.bind(client);
    client.prepareRuntimeProgram = async (call) => {
      requests.push({ role, mode: call.mode, traceOptions: call.traceOptions });
      if (role === 'legacy' && throwObserverCompile) {
        thrownCompiles++;
        throw new Error('injected trace compiler error');
      }
      return prepare(call);
    };
    const run = client.executePreparedTrace.bind(client);
    client.executePreparedTrace = async (handle, call) => {
      requests.push({ role, mode: 'trace', traceEnabled: call.recordTrace });
      return run(handle, call);
    };
    return client;
  };
  const legacy = createLegacyCppDrawingProducer({
    createObserverWorkerClient: () => createClient('legacy'),
  });
  const sparse = createSparseCppDrawingProducer({
    // Released TraceCC has no independently verified map for these programs.
    // The positive map/coordinate control is in the provider unit suite.
    loadArtifact: async () => undefined,
    verifySites: async () => { throw new Error('No map to verify'); },
    createObserver: () => { throw new Error('No copy to execute'); },
  });
  const refusal: CppDrawingProducer = {
    async prepare() {
      return { observe: async () => ({ status: 'refused', reason: 'unsupported-program' }), dispose() {} };
    },
  };
  const suites = [];
  let legacyDrawings = 0;
  for (const [name, producer] of Object.entries({ legacy, sparse, refusal })) {
    const ordinary = createCppOrdinaryExecutionProvider({ createWorkerClient: () => createClient('ordinary') });
    const registration = createCppObservationRegistration(producer, {
      runtimeVersion: 'cpp-b7-test',
      observationDeadlineMs: 60_000,
      observationPrepareDeadlineMs: 60_000,
    });
    const runtimeHost = createBrowserRuntimeHost({
      providerRegistry: createBrowserRuntimeProviderRegistry([{
        id: 'b7-cpp-test',
        languages: ['cpp'],
        create: (): BrowserRuntimeJudgeReceiptLease => ({
          preparedProviders: new Map([['cpp', ordinary]]),
          judgeReceiptProviders: new Map([['cpp', registration]]),
          disposeLanguage: () => ordinary.reset(),
          dispose: () => ordinary.terminate(),
        }),
      }]),
      providers: ['cpp'],
    });
    const host = createBrowserJudgeHostFromRuntimeHost(runtimeHost);
    try {
      for (const fixture of fixtures) {
        const program = {
          code: fixture.code,
          functionName: fixture.functionName ?? 'solve',
          executionStyle: fixture.executionStyle ?? 'solution-method' as const,
        };
        const traceOptions = {
          maxTraceSteps: fixture.maxTraceSteps ?? 4000,
          maxLineEvents: 12000,
          maxSingleLineHits: 1000,
          maxStoredEvents: 16000,
        };
        const bundle = await createAlgorithmJudgeBundle({
          ...program,
          id: fixture.id,
          language: 'cpp',
          trace: true,
          traceOptions,
          cases: fixture.inputs.map((input, index) => ({
            id: index === 0 ? 'A' : 'B',
            input,
            expected: fixture.expected[index]!,
          })),
        });
        const checkRows = (rows: readonly JudgeCaseResult[], path: string) => {
          check(rows.length === fixture.expected.length, fixture.id + '/' + path + '/order');
          rows.forEach((row, index) => {
            const expected = fixture.expected[index]!;
            const label = `${fixture.id}/${name}/${path}/${row.caseId}`;
            check(row.caseId === (index === 0 ? 'A' : 'B'), label + '/id');
            check(row.status === 'completed' && row.verdict.kind === 'passed' &&
              JSON.stringify(row.value) === JSON.stringify(expected),
            `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(row)}`);
            for (const key of ['traceUnavailable', 'traceUnavailableRun', 'untracedRunNeeded', 'providerFailure']) {
              check(!Object.hasOwn(row, key), label + ' leaked ' + key);
            }
            check(row.diagnostics.every(({ code }) => code !== 'trace-unavailable'), label + '/diagnostics');
            if (row.attachment?.status === 'drawn') {
              check(name === 'legacy' && row.trace === row.attachment.trace &&
                row.attachment.trace.events.some(({ kind }) => kind === 'line'), label + '/recorded-trace');
              legacyDrawings++;
            } else {
              check(!Object.hasOwn(row, 'trace'), label + '/absent-trace');
            }
          });
        };

        const run = await host.execute({ bundle, interactive: true, tracing: { caseIds: ['A'] } });
        check(run.evaluation.status === 'completed' && run.evaluation.compile?.status === 'compiled', fixture.id + '/run-first/compile');
        checkRows(run.evaluation.cases, 'run-first');
        const [a, b] = run.evaluation.cases;
        check(a?.attachment && (name === 'legacy' || a.attachment.status === 'refused'),
          fixture.id + '/run-first/A/attachment-status');
        check(b && !Object.hasOwn(b, 'attachment'), fixture.id + '/run-first/B/unselected');
        if (name === 'legacy' && fixture.id.endsWith('/trace-compile')) {
          check(a.attachment.status === 'refused' && a.attachment.reason === 'observer-prepare', fixture.id + '/observer-prepare');
        }
        check(run.executionId, fixture.id + '/run-first/handle');
        await host.disposeExecution(run.executionId);

        // The mux trace request uses the all-selected one-shot receipt path.
        // Assert the inputs to the legacy adapter's aggregate here. Running
        // the pinned mux adapter itself belongs to installed registration.
        throwObserverCompile = name === 'legacy' && fixture.id.endsWith('/trace-compile');
        const receipt = await host.evaluateAlgorithm({ bundle });
        throwObserverCompile = false;
        check(receipt.evaluation.status === 'completed' && receipt.evaluation.compile?.status === 'compiled',
          fixture.id + '/one-shot/compile');
        checkRows(receipt.evaluation.cases, 'one-shot');
        check(receipt.verdict === 'passed' && receipt.passedCount === 2 && receipt.totalCount === 2,
          fixture.id + '/one-shot/aggregate');
        check(receipt.evaluation.cases.every(({ attachment }) =>
          attachment && ((name === 'legacy' && !fixture.id.endsWith('/trace-compile')) || attachment.status === 'refused')),
          fixture.id + '/one-shot/attachment-status');
        suites.push(`${fixture.id}/${name}`);
      }
    } finally {
      await host.dispose();
    }
  }
  check(legacyDrawings > 0, 'the legacy producer never supplied a recorded drawing');
  check(thrownCompiles === 1, 'expected one injected observer compile throw');
  check(requests.some(({ role, mode }) => role === 'legacy' && mode === 'trace'), 'legacy observer was never dispatched');
  check(requests.filter(({ role }) => role === 'ordinary').length === fixtures.length * 3 * 2,
    'expected one ordinary prepare per evaluation');
  check(requests.filter(({ role }) => role === 'ordinary').every(({ mode, traceOptions }) =>
    mode === 'code' && traceOptions === undefined), 'trace options reached ordinary preparation');
  check(requests.every(({ traceEnabled }) => traceEnabled !== false), 'recording-off trace execution');
  return suites;
}


/** Exercise the real per-host C++ composition and the receipt's bind-time verdict. */
export async function assertCppProductReceiptPaths() {
  const host = createBrowserJudgeHost({
    assetBaseUrl: '/workers',
    providers: ['cpp'],
    assets: { runtimeManifests: { cpp: createTraceCCRuntimeManifest('/tracecc') } },
  });
  try {
    const healthy = await createAlgorithmJudgeBundle({
      id: 'cpp-legacy-matches',
      language: 'cpp',
      code: '#include <cstdio>\nclass Solution {\npublic:\n int solve(int n) {\n  printf("learner output\\n");\n  return n + 1;\n }\n};',
      functionName: 'solve',
      executionStyle: 'solution-method',
      trace: true,
      cases: [{ id: 'A', input: { n: 1 }, expected: 2 }],
    });
    const direct = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const judge = yield* host.createJudge({
        language: 'cpp',
        binding: { ...healthy.execution, trace: true },
      });
      return yield* judge.evaluate(healthy.plan);
    })));
    check(direct.status === 'completed' && direct.cases[0]?.status === 'completed' &&
      direct.cases[0].value === 2 && direct.cases[0].stdout === 'learner output\n' &&
      Boolean(direct.cases[0].trace) && !Object.hasOwn(direct.cases[0], 'attachment'),
    'direct trace binding lost its legacy result');

    const receipt = await host.evaluateAlgorithm({ bundle: healthy });
    check(receipt.evaluation.status === 'completed', 'product C++ healthy compile');
    const [row] = receipt.evaluation.cases;
    check(row?.status === 'completed' && row.value === 2 && row.stdout === 'learner output\n' &&
      row.attachment?.status === 'drawn', 'product C++ matching legacy drawing');
    check(!Object.hasOwn(row.attachment, 'finalState'), 'legacy final-state evidence escaped onto an attachment');

    const mismatch = await createAlgorithmJudgeBundle({
      id: 'cpp-legacy-mismatch',
      language: 'cpp',
      code: reference(false),
      functionName: 'solve',
      executionStyle: 'solution-method',
      trace: true,
      cases: [{ id: 'A', input: { nums: [3] }, expected: 0 }],
    });
    const rejected = await host.evaluateAlgorithm({ bundle: mismatch });
    check(rejected.evaluation.status === 'completed', 'product C++ mismatch compile');
    const [mismatching] = rejected.evaluation.cases;
    check(mismatching?.status === 'completed' && mismatching.value === 0 && rejected.verdict === 'passed',
      'product C++ mismatch contaminated the verdict');
    check(mismatching.attachment?.status === 'refused' && mismatching.attachment.reason === 'uncertified-drawing' &&
      !Object.hasOwn(mismatching, 'trace'), 'product C++ mismatched legacy trace was published');
    const budget = fixtures.find(({ id }) => id === 'G5/cpp/step-cap')!;
    for (const [traceOptions, reason] of [
      [{ maxTraceSteps: 2 }, 'step-budget'],
      [{ maxTraceBytes: 1 }, 'byte-budget'],
    ] as const) {
      const bundle = await createAlgorithmJudgeBundle({
        id: reason,
        language: 'cpp',
        code: budget.code,
        functionName: 'solve',
        executionStyle: 'solution-method',
        traceOptions: {
          maxLineEvents: 12000,
          maxSingleLineHits: 1000,
          maxStoredEvents: 16000,
          ...traceOptions,
        },
        trace: true,
        cases: [{ id: 'A', input: { n: 3 }, expected: 3 }],
      });
      const capped = await host.evaluateAlgorithm({ bundle });
      check(capped.evaluation.status === 'completed', reason + '/ordinary compile');
      const [row] = capped.evaluation.cases;
      check(row?.status === 'completed' && row.value === 3 && row.verdict.kind === 'passed', reason + '/ordinary verdict');
      check(row.attachment?.status === 'truncated' && row.attachment.reason === reason &&
        row.attachment.attemptedEvents > row.attachment.trace.events.length &&
        (reason !== 'byte-budget' || row.attachment.trace.events.length === 0),
      reason + '/boundary ' + JSON.stringify(row.attachment));
    }
    return true;
  } finally {
    await host.dispose();
  }
}
