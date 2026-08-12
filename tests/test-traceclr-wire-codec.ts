import assert from 'node:assert/strict';
import {
  decodeTraceClrWireInputs,
  decodeTraceClrWireResult,
  encodeTraceClrWireInputs,
  encodeTraceClrWireResult,
  type TraceClrWireContractDescriptor,
} from '../packages/runtime-csharp/src/traceclr-wire';

const contract: TraceClrWireContractDescriptor = {
  parameters: [
    { name: 'matrix', type: { wireType: 'array<array<int32>>' } },
    { name: 'names', type: { wireType: 'list<string>' } },
    { name: 'seen', type: { wireType: 'set<int32>' } },
    { name: 'head', type: { wireType: 'list-node<int32>' } },
    { name: 'root', type: { wireType: 'tree-node<int32>' } },
  ],
  returnType: { wireType: 'array<int32>' },
};

const encoded = encodeTraceClrWireInputs(contract, {
  matrix: [[1, 2], [], [-3]],
  names: ['hello', '🌍', null],
  seen: new Set([8, 13, 21]),
  head: [5, 6, 7],
  root: [1, 2, 3, null, 5],
});
assert.deepEqual(decodeTraceClrWireInputs(contract, encoded), {
  matrix: [[1, 2], [], [-3]],
  names: ['hello', '🌍', null],
  seen: new Set([8, 13, 21]),
  head: [5, 6, 7],
  root: [1, 2, 3, null, 5],
});
assert.deepEqual(
  (decodeTraceClrWireInputs(contract, encodeTraceClrWireInputs(contract, {
    matrix: [], names: [], seen: [], head: null,
    root: {
      __type__: 'TreeNode', val: 1,
      left: { __type__: 'TreeNode', val: 2, left: null, right: null },
      right: { __type__: 'TreeNode', val: 3, left: null, right: null },
    },
  })) as { root: unknown }).root,
  [1, 2, 3],
);
assert.deepEqual(
  decodeTraceClrWireResult(contract, encodeTraceClrWireResult(contract, [3, 1, 4])),
  [3, 1, 4],
);

const positionalContract: TraceClrWireContractDescriptor = {
  parameters: [
    { name: 'x', type: { wireType: 'int32' } },
    { name: 'y', type: { wireType: 'int32' } },
  ],
  returnType: { wireType: 'int32' },
};
assert.deepEqual(
  decodeTraceClrWireInputs(
    positionalContract,
    encodeTraceClrWireInputs(positionalContract, { a: 3, b: 5 }),
  ),
  { x: 3, y: 5 },
);
assert.deepEqual(
  decodeTraceClrWireInputs(
    positionalContract,
    encodeTraceClrWireInputs(positionalContract, { first: 3, y: 8 }),
  ),
  { x: 3, y: 8 },
);

for (const [wireType, value, expected] of [
  ['int64', 9_007_199_254_740_993n, Number(9_007_199_254_740_993n)],
  ['uint64', 18_446_744_073_709_551_615n, Number(18_446_744_073_709_551_615n)],
] as const) {
  const integerContract: TraceClrWireContractDescriptor = {
    parameters: [],
    returnType: { wireType },
  };
  const decoded = decodeTraceClrWireResult(
    integerContract,
    encodeTraceClrWireResult(integerContract, value),
  );
  assert.equal(decoded, expected);
  assert.doesNotThrow(() => JSON.stringify(decoded));
}

for (const [wireType, value] of [
  ['int64', 10_000_000_000_000_000],
  ['uint64', 18_000_000_000_000_000_000],
] as const) {
  const integerInputContract: TraceClrWireContractDescriptor = {
    parameters: [{ name: 'value', type: { wireType } }],
    returnType: { wireType: 'void' },
  };
  assert.deepEqual(
    decodeTraceClrWireInputs(
      integerInputContract,
      encodeTraceClrWireInputs(integerInputContract, { value }),
    ),
    { value: BigInt(JSON.stringify(value)) },
  );
}

const roundedJsonInteger = 1_000_000_000_000_000_100;
const roundedJsonIntegerContract: TraceClrWireContractDescriptor = {
  parameters: [{ name: 'value', type: { wireType: 'int64' } }],
  returnType: { wireType: 'int64' },
};
assert.deepEqual(
  decodeTraceClrWireInputs(
    roundedJsonIntegerContract,
    encodeTraceClrWireInputs(roundedJsonIntegerContract, {
      value: roundedJsonInteger,
    }),
  ),
  { value: 1_000_000_000_000_000_100n },
);

const setResultContract: TraceClrWireContractDescriptor = {
  parameters: [],
  returnType: { wireType: 'set<int64>' },
};
const setResult = decodeTraceClrWireResult(
  setResultContract,
  encodeTraceClrWireResult(setResultContract, new Set([3n, 5n, 8n])),
);
assert.deepEqual(setResult, [3, 5, 8]);
assert.equal(JSON.stringify(setResult), '[3,5,8]');

for (const [value, expected] of [
  [Number.NaN, 'NaN'],
  [Number.POSITIVE_INFINITY, 'Infinity'],
  [Number.NEGATIVE_INFINITY, '-Infinity'],
] as const) {
  const floatingPointContract: TraceClrWireContractDescriptor = {
    parameters: [],
    returnType: { wireType: 'array<float64>' },
  };
  assert.deepEqual(
    decodeTraceClrWireResult(
      floatingPointContract,
      encodeTraceClrWireResult(floatingPointContract, [value]),
    ),
    [expected],
  );
}

const largeContract: TraceClrWireContractDescriptor = {
  parameters: [{ name: 'value', type: { wireType: 'string' } }],
  returnType: { wireType: 'string' },
};
const largeValue = '🐝'.repeat(2_000);
assert.deepEqual(
  decodeTraceClrWireInputs(largeContract, encodeTraceClrWireInputs(largeContract, { value: largeValue })),
  { value: largeValue },
);
const largeResultValue = 'x'.repeat(1_000_001);
assert.equal(
  decodeTraceClrWireResult(
    largeContract,
    encodeTraceClrWireResult(largeContract, largeResultValue),
  ),
  largeResultValue,
);

assert.throws(() => encodeTraceClrWireInputs(contract, {}), /Missing TraceCLR input/);
assert.throws(
  () => decodeTraceClrWireInputs(contract, Uint8Array.from([...encoded, 0])),
  /trailing bytes/,
);
assert.throws(
  () => decodeTraceClrWireInputs(contract, Uint8Array.from([0, 0, 0, 0])),
  /magic\/version mismatch/,
);

const charContract: TraceClrWireContractDescriptor = {
  parameters: [{ name: 'value', type: { wireType: 'char' } }],
  returnType: { wireType: 'char' },
};
assert.throws(
  () => encodeTraceClrWireInputs(charContract, { value: '😀' }),
  /one UTF-16 code unit/,
);
assert.deepEqual(
  decodeTraceClrWireInputs(
    charContract,
    encodeTraceClrWireInputs(charContract, { value: 'é' }),
  ),
  { value: 'é' },
);

console.log('TraceCLR wire codec tests passed.');
