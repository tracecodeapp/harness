#!/usr/bin/env npx tsx

import { test } from 'node:test';
import { createNativeHarness } from '../packages/runtime-native/src/index';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const harness = createNativeHarness();
  try {
    const python = harness.getClient('python');
    await python.init();
    const result = await python.execute({
      kind: 'code',
      code: [
        'class EmptyEncoder:',
        '    def encode(self, value):',
        '        return ""',
        'json.JSONEncoder = EmptyEncoder',
        'json.dumps = lambda *args, **kwargs: ""',
        '_serialize = lambda *args, **kwargs: "bypass"',
        '_TracecodeSerializationLimit = Exception',
        'def solve(size):',
        '    return "x" * size',
      ].join('\n'),
      functionName: 'solve',
      cases: [
        { id: 'before-limit', inputs: { size: 1 }, expected: 'x' },
        { id: 'serialization-limit', inputs: { size: 9 * 1024 * 1024 } },
        { id: 'after-limit', inputs: { size: 2 }, expected: 'xx' },
      ],
    });

    assertCondition(
      result.success === false &&
        result.cases[0]?.passed === true &&
        result.cases[1]?.outcome.kind === 'limit' &&
        result.cases[1].outcome.reason === 'serialization-limit' &&
        result.cases[1].outcome.error.includes('serialization-limit') &&
        result.cases[2]?.passed === true,
      `Native Python serialization limits must remain trusted and case-local: ${JSON.stringify(result)}`
    );
  } finally {
    harness.dispose();
  }
}

await test('native Python serialization limit', main);
