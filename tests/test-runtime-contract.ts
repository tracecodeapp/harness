#!/usr/bin/env npx tsx

import { spawnSync } from 'node:child_process';
import {
  SUPPORTED_LANGUAGES,
  getLanguageRuntimeProfile,
  getRuntimeClient,
  getSupportedLanguageProfiles,
  isLanguageSupported,
} from '../packages/harness-browser/src/runtime-client';
import { assertRuntimeRequestSupported } from '../packages/harness-browser/src/runtime-capability-guards';
import { executeJavaScriptCode, executeTypeScriptCode } from '../packages/harness-javascript/src/javascript-executor';
import { generateSolutionScript } from '../packages/harness-python/src/python-harness';
import type { Language, LanguageRuntimeProfile, RuntimeCapabilities } from '../packages/harness-core/src/runtime-types';
import {
  normalizeRuntimeTraceContract,
  RUNTIME_TRACE_CONTRACT_SCHEMA_VERSION,
} from '../packages/harness-core/src/trace-contract';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function expectThrows(fn: () => void, expectedMessage: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assertCondition(thrown instanceof Error, `Expected error containing "${expectedMessage}"`);
  assertCondition(
    String((thrown as Error).message).includes(expectedMessage),
    `Expected error containing "${expectedMessage}", received "${String((thrown as Error).message)}"`
  );
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableStringify(obj[key])).join(',') + '}';
}

function collectEnabledCapabilityPaths(
  value: RuntimeCapabilities | Record<string, unknown>,
  prefix = ''
): string[] {
  return Object.entries(value).flatMap(([key, nestedValue]) => {
    const nextPath = prefix ? `${prefix}.${key}` : key;
    if (typeof nestedValue === 'boolean') {
      return nestedValue ? [nextPath] : [];
    }
    if (nestedValue && typeof nestedValue === 'object' && !Array.isArray(nestedValue)) {
      return collectEnabledCapabilityPaths(nestedValue as Record<string, unknown>, nextPath);
    }
    return [];
  });
}

const COMMON_STABLE_COVERAGE = [
  'execution.styles.function',
  'execution.styles.solutionMethod',
  'execution.styles.opsClass',
  'execution.styles.script',
  'execution.styles.interviewMode',
  'execution.timeouts.clientTimeouts',
  'tracing.supported',
  'tracing.events.line',
  'tracing.events.call',
  'tracing.events.return',
  'tracing.events.exception',
  'tracing.events.timeout',
  'tracing.controls.maxTraceSteps',
  'tracing.controls.maxLineEvents',
  'tracing.controls.maxSingleLineHits',
  'tracing.controls.minimalTrace',
  'tracing.fidelity.preciseLineMapping',
  'tracing.fidelity.stableFunctionNames',
  'tracing.fidelity.callStack',
  'diagnostics.runtimeErrors',
  'structures.treeNodeRefs',
  'structures.listNodeRefs',
  'structures.mapSerialization',
  'structures.setSerialization',
  'structures.graphSerialization',
  'structures.cycleReferences',
  'visualization.runtimePayloads',
  'visualization.objectKinds',
  'visualization.hashMaps',
  'visualization.stepVisualization',
] as const satisfies readonly string[];

const LANGUAGE_CONFORMANCE_COVERAGE: Record<Language, readonly string[]> = {
  python: [
    ...COMMON_STABLE_COVERAGE,
    'execution.timeouts.runtimeTimeouts',
    'tracing.events.stdout',
    'diagnostics.mappedErrorLines',
  ],
  javascript: [...COMMON_STABLE_COVERAGE],
  typescript: [
    ...COMMON_STABLE_COVERAGE,
    'diagnostics.compileErrors',
    'diagnostics.mappedErrorLines',
  ],
};

function assertProfileCoverageAlignment(profile: LanguageRuntimeProfile): void {
  const declaredCapabilities = new Set(collectEnabledCapabilityPaths(profile.capabilities));
  const coveredCapabilities = new Set(LANGUAGE_CONFORMANCE_COVERAGE[profile.language] ?? []);

  for (const capabilityPath of declaredCapabilities) {
    assertCondition(
      coveredCapabilities.has(capabilityPath),
      `${profile.language} declares capability "${capabilityPath}" without matching conformance coverage`
    );
  }
}

function createUnsupportedProfile(
  overrides: Partial<LanguageRuntimeProfile['capabilities']> = {}
): LanguageRuntimeProfile {
  return {
    language: 'javascript',
    maturity: 'experimental',
    capabilities: {
      execution: {
        styles: {
          function: true,
          solutionMethod: false,
          opsClass: false,
          script: false,
          interviewMode: false,
        },
        timeouts: {
          clientTimeouts: true,
          runtimeTimeouts: false,
        },
      },
      tracing: {
        supported: false,
        events: {
          line: false,
          call: false,
          return: false,
          exception: false,
          stdout: false,
          timeout: false,
        },
        controls: {
          maxTraceSteps: false,
          maxLineEvents: false,
          maxSingleLineHits: false,
          minimalTrace: false,
        },
        fidelity: {
          preciseLineMapping: false,
          stableFunctionNames: false,
          callStack: false,
        },
      },
      diagnostics: {
        compileErrors: false,
        runtimeErrors: true,
        mappedErrorLines: false,
        stackTraces: false,
      },
      structures: {
        treeNodeRefs: false,
        listNodeRefs: false,
        mapSerialization: false,
        setSerialization: false,
        graphSerialization: false,
        cycleReferences: false,
      },
      visualization: {
        runtimePayloads: false,
        objectKinds: false,
        hashMaps: false,
        stepVisualization: false,
      },
      ...overrides,
    },
  };
}

function runPythonCase(
  solutionCode: string,
  functionName: string,
  inputs: Record<string, unknown>
): { success: boolean; output?: unknown; error?: string } {
  const script = generateSolutionScript(solutionCode, functionName, inputs);
  const run = spawnSync('python3', ['-c', script], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });

  if (run.error) {
    throw new Error(`python3 execution failed: ${run.error.message}`);
  }
  if (run.status !== 0) {
    throw new Error(`python3 exited with code ${run.status}: ${run.stderr || run.stdout}`);
  }

  const lines = String(run.stdout || '')
    .trim()
    .split('\n')
    .filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) {
    throw new Error('No JSON output from python process');
  }

  const parsed = JSON.parse(last) as { success: boolean; output?: unknown; error?: string };
  return parsed;
}

function testRuntimeTraceContractAccessNormalization(): void {
  const normalized = normalizeRuntimeTraceContract('javascript', {
    success: true,
    output: 3,
    trace: [
      {
        line: 2,
        event: 'line',
        function: 'solve',
        variables: {
          arr: [1, 2, 3],
        },
        accesses: [
          {
            variable: 'arr',
            kind: 'indexed-read',
            indices: [1.8],
            pathDepth: 1,
          },
          {
            variable: 'grid',
            kind: 'cell-write',
            indices: [2, 3],
            pathDepth: 2,
          },
          {
            variable: '',
            kind: 'indexed-read',
          },
        ],
      },
    ],
    executionTimeMs: 1,
    consoleOutput: [],
  });

  assertCondition(
    normalized.schemaVersion === RUNTIME_TRACE_CONTRACT_SCHEMA_VERSION,
    'normalized runtime traces should use the latest schema version'
  );
  assertCondition(normalized.trace[0]?.accesses?.length === 2, 'normalization should preserve valid access events');
  assertCondition(
    normalized.trace[0]?.accesses?.[0]?.indices?.[0] === 1,
    'normalization should floor numeric access indices'
  );
  assertCondition(
    normalized.trace[0]?.accesses?.[1]?.kind === 'cell-write',
    'normalization should preserve cell access kinds'
  );
  console.log('PASS: runtime trace contract preserves access metadata');
}

async function main(): Promise<void> {
  testRuntimeTraceContractAccessNormalization();
  const profiles = getSupportedLanguageProfiles();

  assertCondition(SUPPORTED_LANGUAGES.includes('python'), 'SUPPORTED_LANGUAGES should include python');
  assertCondition(SUPPORTED_LANGUAGES.includes('javascript'), 'SUPPORTED_LANGUAGES should include javascript');
  assertCondition(SUPPORTED_LANGUAGES.includes('typescript'), 'SUPPORTED_LANGUAGES should include typescript');
  assertCondition(
    stableStringify(SUPPORTED_LANGUAGES) === stableStringify(profiles.map((profile) => profile.language)),
    'SUPPORTED_LANGUAGES should stay aligned with the runtime profile registry'
  );
  for (const language of SUPPORTED_LANGUAGES) {
    assertCondition(isLanguageSupported(language), `${language} should be reported as supported`);
    assertCondition(
      getLanguageRuntimeProfile(language).language === language,
      `${language} should resolve a matching runtime profile`
    );
  }
  console.log('PASS: runtime language/profile registry');

  const pythonClient = getRuntimeClient('python');
  const javascriptClient = getRuntimeClient('javascript');
  const typescriptClient = getRuntimeClient('typescript');
  for (const [name, client] of [
    ['python', pythonClient],
    ['javascript', javascriptClient],
    ['typescript', typescriptClient],
  ] as const) {
    assertCondition(
      typeof (client as { getCapabilities?: unknown }).getCapabilities === 'undefined',
      `${name} client should not expose getCapabilities`
    );
    assertCondition(typeof client.init === 'function', `${name} client should implement init`);
    assertCondition(typeof client.executeCode === 'function', `${name} client should implement executeCode`);
    assertCondition(
      typeof client.executeWithTracing === 'function',
      `${name} client should implement executeWithTracing`
    );
    assertCondition(
      typeof client.executeCodeInterviewMode === 'function',
      `${name} client should implement executeCodeInterviewMode`
    );
  }
  console.log('PASS: runtime adapter surface contract');

  const pythonProfile = getLanguageRuntimeProfile('python');
  const javascriptProfile = getLanguageRuntimeProfile('javascript');
  const typescriptProfile = getLanguageRuntimeProfile('typescript');
  for (const profile of profiles) {
    assertCondition(profile.maturity === 'stable', `${profile.language} should be marked stable in this release`);
    assertProfileCoverageAlignment(profile);
  }
  assertCondition(pythonProfile.capabilities.tracing.supported, 'Python should support tracing');
  assertCondition(
    pythonProfile.capabilities.visualization.stepVisualization,
    'Python should support step visualization'
  );
  assertCondition(
    pythonProfile.capabilities.execution.timeouts.runtimeTimeouts,
    'Python should advertise runtime-side timeouts'
  );
  assertCondition(
    javascriptProfile.capabilities.execution.styles.script,
    'JavaScript should support script mode execution'
  );
  assertCondition(
    javascriptProfile.capabilities.structures.listNodeRefs,
    'JavaScript should advertise linked-list ref hydration'
  );
  assertCondition(
    javascriptProfile.capabilities.visualization.runtimePayloads,
    'JavaScript should advertise runtime visualization payloads'
  );
  assertCondition(typescriptProfile.capabilities.diagnostics.compileErrors, 'TypeScript should support compile errors');
  assertCondition(
    typescriptProfile.capabilities.diagnostics.mappedErrorLines,
    'TypeScript should preserve mapped compile error lines'
  );
  console.log('PASS: runtime capability profile matrix');

  const unsupportedProfile = createUnsupportedProfile();
  expectThrows(
    () =>
      assertRuntimeRequestSupported(unsupportedProfile, {
        request: 'trace',
        executionStyle: 'function',
        functionName: 'solve',
      }),
    'does not support tracing'
  );
  expectThrows(
    () =>
      assertRuntimeRequestSupported(unsupportedProfile, {
        request: 'execute',
        executionStyle: 'solution-method',
        functionName: 'solve',
      }),
    'does not support execution style "solution-method"'
  );
  expectThrows(
    () =>
      assertRuntimeRequestSupported(unsupportedProfile, {
        request: 'execute',
        executionStyle: 'function',
        functionName: null,
      }),
    'does not support script mode execution'
  );
  expectThrows(
    () =>
      assertRuntimeRequestSupported(unsupportedProfile, {
        request: 'interview',
        executionStyle: 'function',
        functionName: 'solve',
      }),
    'does not support interview execution'
  );
  console.log('PASS: unsupported capability guards');

  const functionCase = {
    functionName: 'compute',
    inputs: { nums: [3, 1, 4], delta: 2 },
    pythonCode: `
def compute(nums, delta):
    return [n + delta for n in nums]
`,
    javascriptCode: `
function compute(nums, delta) {
  return nums.map((n) => n + delta);
}
`,
  };

  const pythonSuccess = runPythonCase(
    functionCase.pythonCode,
    functionCase.functionName,
    functionCase.inputs
  );
  assertCondition(pythonSuccess.success === true, 'Python function case should succeed');

  const javascriptSuccess = await executeJavaScriptCode(
    functionCase.javascriptCode,
    functionCase.functionName,
    functionCase.inputs,
    'function'
  );
  assertCondition(javascriptSuccess.success === true, 'JavaScript function case should succeed');
  assertCondition(
    stableStringify(javascriptSuccess.output) === stableStringify(pythonSuccess.output),
    `Cross-runtime output mismatch.\npython=${stableStringify(pythonSuccess.output)}\njavascript=${stableStringify(javascriptSuccess.output)}`
  );
  console.log('PASS: cross-runtime function-style output parity');

  const typescriptSuccess = await executeTypeScriptCode(
    `
function compute(nums: number[], delta: number): number[] {
  return nums.map((n) => n + delta);
}
`,
    functionCase.functionName,
    functionCase.inputs,
    'function'
  );
  assertCondition(typescriptSuccess.success === true, 'TypeScript function case should succeed');
  assertCondition(
    stableStringify(typescriptSuccess.output) === stableStringify(pythonSuccess.output),
    `Cross-runtime output mismatch.\npython=${stableStringify(pythonSuccess.output)}\ntypescript=${stableStringify(typescriptSuccess.output)}`
  );
  console.log('PASS: cross-runtime TypeScript parity');

  const pythonError = runPythonCase('def other():\n    return 1\n', 'missing_function', {});
  const javascriptError = await executeJavaScriptCode(
    'function other() { return 1; }',
    'missing_function',
    {},
    'function'
  );
  assertCondition(pythonError.success === false, 'Python missing function case should fail');
  assertCondition(javascriptError.success === false, 'JavaScript missing function case should fail');
  assertCondition(
    typeof pythonError.error === 'string' && pythonError.error.length > 0,
    'Python missing function case should include error'
  );
  assertCondition(
    typeof javascriptError.error === 'string' && javascriptError.error.length > 0,
    'JavaScript missing function case should include error'
  );
  console.log('PASS: cross-runtime diagnostics contract');

  const opsClassCode = `
class Counter {
  constructor(start) {
    this.v = start;
  }
  inc(delta) {
    this.v += delta;
    return this.v;
  }
  get() {
    return this.v;
  }
}
`;
  const opsClassInputs = {
    operations: ['Counter', 'inc', 'inc', 'get'],
    arguments: [[1], [2], [3], []],
  };
  const jsOpsClass = await executeJavaScriptCode(
    opsClassCode,
    'Counter',
    opsClassInputs,
    'ops-class'
  );
  assertCondition(jsOpsClass.success === true, 'JavaScript ops-class case should succeed');
  assertCondition(
    stableStringify(jsOpsClass.output) === stableStringify([null, 3, 6, 6]),
    `JavaScript ops-class output mismatch: ${stableStringify(jsOpsClass.output)}`
  );
  const tsOpsClass = await executeTypeScriptCode(
    opsClassCode,
    'Counter',
    opsClassInputs,
    'ops-class'
  );
  assertCondition(tsOpsClass.success === true, 'TypeScript ops-class case should succeed');
  assertCondition(
    stableStringify(tsOpsClass.output) === stableStringify([null, 3, 6, 6]),
    `TypeScript ops-class output mismatch: ${stableStringify(tsOpsClass.output)}`
  );
  console.log('PASS: runtime execution style contract');

  const linkedListCycleRefInput = {
    head: {
      __id__: 'n0',
      val: 1,
      next: {
        __id__: 'n1',
        val: 2,
        next: {
          __ref__: 'n0',
        },
      },
    },
  };
  const linkedListCycleCode = `
class Solution {
  hasCycle(head) {
    let slow = head;
    let fast = head;
    while (fast && fast.next) {
      slow = slow.next;
      fast = fast.next.next;
      if (slow === fast) return true;
    }
    return false;
  }
}
`;

  const jsLinkedListCycle = await executeJavaScriptCode(
    linkedListCycleCode,
    'hasCycle',
    linkedListCycleRefInput,
    'solution-method'
  );
  assertCondition(jsLinkedListCycle.success === true, 'JavaScript linked-list ref cycle should execute successfully');
  assertCondition(jsLinkedListCycle.output === true, 'JavaScript linked-list ref cycle should resolve object identity');

  const tsLinkedListCycle = await executeTypeScriptCode(
    linkedListCycleCode,
    'hasCycle',
    linkedListCycleRefInput,
    'solution-method'
  );
  assertCondition(tsLinkedListCycle.success === true, 'TypeScript linked-list ref cycle should execute successfully');
  assertCondition(tsLinkedListCycle.output === true, 'TypeScript linked-list ref cycle should resolve object identity');
  console.log('PASS: runtime linked-list ref hydration contract');

  const treeAliasRefInput = {
    root: {
      __id__: 'root',
      val: 9,
      left: {
        __id__: 'child',
        val: 3,
        left: null,
        right: null,
      },
      right: {
        __ref__: 'child',
      },
    },
  };
  const treeAliasCode = `
function hasAliasedChildren(root) {
  return !!root && root.left === root.right;
}
`;
  const jsTreeAlias = await executeJavaScriptCode(
    treeAliasCode,
    'hasAliasedChildren',
    treeAliasRefInput,
    'function'
  );
  assertCondition(jsTreeAlias.success === true, 'JavaScript tree alias refs should execute successfully');
  assertCondition(jsTreeAlias.output === true, 'JavaScript tree alias refs should preserve shared identity');
  const tsTreeAlias = await executeTypeScriptCode(
    treeAliasCode,
    'hasAliasedChildren',
    treeAliasRefInput,
    'function'
  );
  assertCondition(tsTreeAlias.success === true, 'TypeScript tree alias refs should execute successfully');
  assertCondition(tsTreeAlias.output === true, 'TypeScript tree alias refs should preserve shared identity');
  console.log('PASS: runtime tree ref hydration contract');

  console.log('\nRuntime contract tests passed.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
