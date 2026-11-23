import { createCppOrdinaryExecutionProvider } from '../../packages/runtime-cpp/src/cpp-prepared-provider';
import {
  createCppObservationRegistration,
  createLegacyCppDrawingProducer,
  createSparseCppDrawingProducer,
  type CppDrawingProducer,
} from '../../packages/runtime-cpp/src/cpp-observation';
import { CppWorkerClient, type CppWorkerClientOptions } from '../../packages/runtime-cpp/src/cpp-worker-client';

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
  const requests: Array<{ role: string; mode?: string; traceEnabled?: boolean; traceOptions?: object }> = [];
  const createClient = (role: string) => {
    const client = new CppWorkerClient(options);
    const prepare = client.prepareRuntimeProgram.bind(client);
    client.prepareRuntimeProgram = async (call) => {
      requests.push({ role, mode: call.mode, traceOptions: call.traceOptions });
      return prepare(call);
    };
    const run = client.executePreparedTrace.bind(client);
    client.executePreparedTrace = async (handle, call) => {
      requests.push({ role, mode: 'trace', traceEnabled: call.recordTrace });
      return run(handle, call);
    };
    return client;
  };
  const ordinary = createCppOrdinaryExecutionProvider({ createWorkerClient: () => createClient('ordinary') });
  const legacy = createLegacyCppDrawingProducer({
    createObserverWorkerClient: () => createClient('legacy'),
    // The rewritten artifact runs as a negative control. Its events do not
    // independently establish that its execution represents this source.
    certify: () => ({ status: 'refused', reason: 'uncertified-drawing' }),
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
  try {
    for (const [name, producer] of Object.entries({ legacy, sparse, refusal })) {
      const registration = createCppObservationRegistration(producer, 60_000);
      for (const fixture of fixtures) {
        const program = {
          code: fixture.code,
          functionName: fixture.functionName ?? 'solve',
          executionStyle: fixture.executionStyle ?? 'solution-method' as const,
        };
        const traceOptions = { maxTraceSteps: fixture.maxTraceSteps ?? 4000, maxLineEvents: 12000, maxSingleLineHits: 1000, maxStoredEvents: 16000 };
        const request = { program, traceOptions };
        const observation = registration.prepareObservation(request);
        const prepared = await ordinary.prepareProgram({ ...program, mode: 'code', traceOptions });
        const lease = await observation;
        try {
          check(prepared.kind === 'prepared' && prepared.program.mode === 'code', fixture.id + '/compile');
          const executable = prepared.program;
          try {
            // The same code artifact serves single, mixed selection and all
            // selected (one-shot shape), regardless of the observation result.
            const selected = (index: number) => lease.observe({
              ...request, attemptToken: String(index), inputs: structuredClone(fixture.inputs[index]!),
            });
            const mixed = await Promise.all([
              selected(0),
              executable.executeBatchIsolated!({ inputBatch: fixture.inputs }),
            ]);
            const oneShot = await Promise.all([
              selected(0), selected(1),
              executable.executeBatchIsolated!({ inputBatch: fixture.inputs }),
            ]);
            const single = await executable.executeIsolated({ inputs: fixture.inputs[0]! });
            const rows = [...mixed[1], ...oneShot[2], single];
            for (const [index, row] of rows.entries()) {
              const expected = fixture.expected[[0, 1, 0, 1, 0][index]!]!;
              check(row.kind === 'completed' && JSON.stringify(row.output) === JSON.stringify(expected),
                `${fixture.id}/${name}/${index}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(row)}`);
              for (const key of ['trace', 'traceUnavailable', 'traceUnavailableRun', 'untracedRunNeeded', 'providerFailure']) {
                check(!Object.hasOwn(row, key), `${fixture.id}/${name} leaked ${key}`);
              }
            }
            check(mixed[0].status === 'refused', fixture.id + '/attachment-status');
            if (name === 'legacy' && fixture.id.endsWith('/trace-compile')) {
              check(mixed[0].reason === 'observer-prepare', fixture.id + '/observer-prepare');
            }
            suites.push(`${fixture.id}/${name}`);
          } finally {
            await executable.dispose();
          }
        } finally {
          await lease.dispose();
        }
      }
    }
  } finally {
    ordinary.terminate();
  }
  check(requests.some(({ role, mode }) => role === 'legacy' && mode === 'trace'), 'legacy observer was never dispatched');
  check(requests.filter(({ role }) => role === 'ordinary').length === fixtures.length * 3, 'expected one ordinary prepare per fixture and producer');
  check(requests.filter(({ role }) => role === 'ordinary').every(({ mode, traceOptions }) =>
    mode === 'code' && traceOptions === undefined), 'trace options reached ordinary preparation');
  check(requests.every(({ traceEnabled }) => traceEnabled !== false), 'recording-off trace execution');
  return suites;
}
