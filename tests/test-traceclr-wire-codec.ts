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

const largeContract: TraceClrWireContractDescriptor = {
  parameters: [{ name: 'value', type: { wireType: 'string' } }],
  returnType: { wireType: 'string' },
};
const largeValue = '🐝'.repeat(2_000);
assert.deepEqual(
  decodeTraceClrWireInputs(largeContract, encodeTraceClrWireInputs(largeContract, { value: largeValue })),
  { value: largeValue },
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

console.log('TraceCLR wire codec tests passed.');
