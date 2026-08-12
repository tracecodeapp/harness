const startedAt = performance.now();
const { dotnet } = await import('./_framework/dotnet.js');
const runtime = await dotnet.create();
const exports = await runtime.getAssemblyExports(
  runtime.getConfig().mainAssemblyName
);
const runner = exports.TraceCode.CSharpAlgorithmRunner.Program;
const learnerAssembly = new Uint8Array(
  await fetch('./TraceCode.TraceClrWireProbe.dll').then((response) => {
    if (!response.ok) throw new Error(`Learner artifact HTTP ${response.status}`);
    return response.arrayBuffer();
  })
);

function writeInt32(bytes, offset, value) {
  bytes[offset] = value;
  bytes[offset + 1] = value >>> 8;
  bytes[offset + 2] = value >>> 16;
  bytes[offset + 3] = value >>> 24;
}

function encodeInput(nums, target) {
  const bytes = new Uint8Array(8 + nums.length * 4);
  writeInt32(bytes, 0, nums.length);
  nums.forEach((value, index) => writeInt32(bytes, 4 + index * 4, value));
  writeInt32(bytes, 4 + nums.length * 4, target);
  return bytes;
}

function readInt32(bytes, offset) {
  return (
    bytes[offset]
    | bytes[offset + 1] << 8
    | bytes[offset + 2] << 16
    | bytes[offset + 3] << 24
  );
}

function decodeOutput(bytes) {
  const length = readInt32(bytes, 0);
  const values = Array.from(
    { length },
    (_, index) => readInt32(bytes, 4 + index * 4)
  );
  const executionCount = readInt32(bytes, 4 + length * 4);
  return { values, executionCount };
}

const input = encodeInput([2, 7, 11, 15], 9);
const first = decodeOutput(runner.Execute(learnerAssembly, input));
const second = decodeOutput(runner.Execute(learnerAssembly, input));
postMessage({
  schema: 'tracecode.traceclr-wire-probe.v1',
  first,
  second,
  totalMs: performance.now() - startedAt,
  wasmHeapBytes: runtime.Module?.HEAPU8?.buffer?.byteLength ?? null,
});
