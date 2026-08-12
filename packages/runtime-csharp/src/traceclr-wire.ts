const WIRE_MAGIC = 0x31574354;

export const TRACECLR_WIRE_LIMITS = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  maxCollectionItems: 1_000_000,
  maxDepth: 128,
});

export interface TraceClrWireTypeDescriptor {
  readonly wireType: string;
}

export interface TraceClrWireParameterDescriptor {
  readonly name: string;
  readonly type: TraceClrWireTypeDescriptor;
}

export interface TraceClrWireContractDescriptor {
  readonly parameters: readonly TraceClrWireParameterDescriptor[];
  readonly returnType: TraceClrWireTypeDescriptor;
}

type WireType =
  | { kind: 'scalar'; name: string }
  | { kind: 'container'; name: 'array' | 'list' | 'set'; element: WireType }
  | { kind: 'list-node' }
  | { kind: 'tree-node' };

class WireWriter {
  private buffer = new ArrayBuffer(256);
  private view = new DataView(this.buffer);
  private length = 0;

  private reserve(bytes: number): number {
    const next = this.length + bytes;
    if (!Number.isSafeInteger(bytes) || bytes < 0 || next > TRACECLR_WIRE_LIMITS.maxBytes) {
      throw new RangeError(`TraceCLR wire payload exceeds ${TRACECLR_WIRE_LIMITS.maxBytes} bytes.`);
    }
    if (next > this.buffer.byteLength) {
      let capacity = this.buffer.byteLength;
      while (capacity < next) capacity = Math.min(TRACECLR_WIRE_LIMITS.maxBytes, capacity * 2);
      const replacement = new ArrayBuffer(capacity);
      new Uint8Array(replacement).set(new Uint8Array(this.buffer, 0, this.length));
      this.buffer = replacement;
      this.view = new DataView(replacement);
    }
    const offset = this.length;
    this.length = next;
    return offset;
  }

  uint8(value: number): void { const offset = this.reserve(1); this.view.setUint8(offset, value); }
  int8(value: number): void { const offset = this.reserve(1); this.view.setInt8(offset, value); }
  int16(value: number): void { const offset = this.reserve(2); this.view.setInt16(offset, value, true); }
  uint16(value: number): void { const offset = this.reserve(2); this.view.setUint16(offset, value, true); }
  int32(value: number): void { const offset = this.reserve(4); this.view.setInt32(offset, value, true); }
  uint32(value: number): void { const offset = this.reserve(4); this.view.setUint32(offset, value, true); }
  int64(value: bigint): void { const offset = this.reserve(8); this.view.setBigInt64(offset, value, true); }
  uint64(value: bigint): void { const offset = this.reserve(8); this.view.setBigUint64(offset, value, true); }
  float32(value: number): void { const offset = this.reserve(4); this.view.setFloat32(offset, value, true); }
  float64(value: number): void { const offset = this.reserve(8); this.view.setFloat64(offset, value, true); }

  bytes(value: Uint8Array): void {
    const offset = this.reserve(value.byteLength);
    new Uint8Array(this.buffer, offset, value.byteLength).set(value);
  }

  finish(): Uint8Array {
    return new Uint8Array(this.buffer.slice(0, this.length));
  }
}

class WireReader {
  private readonly view: DataView;
  private offset = 0;

  constructor(bytes: Uint8Array) {
    if (bytes.byteLength > TRACECLR_WIRE_LIMITS.maxBytes) {
      throw new RangeError(`TraceCLR wire payload exceeds ${TRACECLR_WIRE_LIMITS.maxBytes} bytes.`);
    }
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private take(bytes: number): number {
    if (this.offset + bytes > this.view.byteLength) {
      throw new RangeError('TraceCLR wire payload ended unexpectedly.');
    }
    const offset = this.offset;
    this.offset += bytes;
    return offset;
  }

  uint8(): number { return this.view.getUint8(this.take(1)); }
  int8(): number { return this.view.getInt8(this.take(1)); }
  int16(): number { return this.view.getInt16(this.take(2), true); }
  uint16(): number { return this.view.getUint16(this.take(2), true); }
  int32(): number { return this.view.getInt32(this.take(4), true); }
  uint32(): number { return this.view.getUint32(this.take(4), true); }
  int64(): bigint { return this.view.getBigInt64(this.take(8), true); }
  uint64(): bigint { return this.view.getBigUint64(this.take(8), true); }
  float32(): number { return this.view.getFloat32(this.take(4), true); }
  float64(): number { return this.view.getFloat64(this.take(8), true); }

  bytes(length: number): Uint8Array {
    return new Uint8Array(this.view.buffer, this.view.byteOffset + this.take(length), length);
  }

  done(): void {
    if (this.offset !== this.view.byteLength) {
      throw new RangeError(`TraceCLR wire payload has ${this.view.byteLength - this.offset} trailing bytes.`);
    }
  }
}

function parseWireType(text: string, depth = 0): WireType {
  if (depth > TRACECLR_WIRE_LIMITS.maxDepth) throw new RangeError('TraceCLR wire type is too deeply nested.');
  if (text === 'list-node<int32>') return { kind: 'list-node' };
  if (text === 'tree-node<int32>') return { kind: 'tree-node' };
  for (const name of ['array', 'list', 'set'] as const) {
    const prefix = `${name}<`;
    if (text.startsWith(prefix) && text.endsWith('>')) {
      return { kind: 'container', name, element: parseWireType(text.slice(prefix.length, -1), depth + 1) };
    }
  }
  const scalars = new Set([
    'void', 'null', 'bool', 'char', 'uint8', 'int8', 'int16', 'uint16', 'int32', 'uint32',
    'int64', 'uint64', 'float32', 'float64', 'string',
  ]);
  if (!scalars.has(text)) throw new TypeError(`Unsupported TraceCLR wire type: ${text}`);
  return { kind: 'scalar', name: text };
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function integer64(value: unknown, signed: boolean): bigint {
  const converted = typeof value === 'bigint'
    ? value
    : typeof value === 'number' && Number.isSafeInteger(value)
      ? BigInt(value)
      : null;
  const minimum = signed ? -(1n << 63n) : 0n;
  const maximum = signed ? (1n << 63n) - 1n : (1n << 64n) - 1n;
  if (converted === null || converted < minimum || converted > maximum) {
    throw new TypeError(`${signed ? 'int64' : 'uint64'} must be a bigint or safe integer in range.`);
  }
  return converted;
}

function collection(value: unknown, set: boolean): readonly unknown[] {
  const items = set && value instanceof Set ? [...value] : value;
  if (!Array.isArray(items)) throw new TypeError('TraceCLR collection values must be arrays or Sets.');
  if (items.length > TRACECLR_WIRE_LIMITS.maxCollectionItems) {
    throw new RangeError(`TraceCLR collection exceeds ${TRACECLR_WIRE_LIMITS.maxCollectionItems} items.`);
  }
  return items;
}

function writeValue(writer: WireWriter, type: WireType, value: unknown, depth: number): void {
  if (depth > TRACECLR_WIRE_LIMITS.maxDepth) throw new RangeError('TraceCLR value is too deeply nested.');
  if (type.kind === 'container') {
    if (value === null) { writer.int32(-1); return; }
    const values = collection(value, type.name === 'set');
    writer.int32(values.length);
    for (const item of values) writeValue(writer, type.element, item, depth + 1);
    return;
  }
  if (type.kind === 'list-node') {
    if (value === null) { writer.int32(-1); return; }
    const values: unknown[] = Array.isArray(value) ? value : [];
    if (!Array.isArray(value)) {
      const seen = new Set<object>();
      let node: unknown = value;
      while (node !== null) {
        if (typeof node !== 'object' || seen.has(node)) throw new TypeError('TraceCLR ListNode must be acyclic.');
        seen.add(node);
        values.push((node as { val?: unknown; value?: unknown }).val ?? (node as { value?: unknown }).value);
        node = (node as { next?: unknown }).next ?? null;
        if (values.length > TRACECLR_WIRE_LIMITS.maxCollectionItems) throw new RangeError('TraceCLR ListNode is too long.');
      }
    }
    writer.int32(values.length);
    for (const item of values) writer.int32(integer(item, -2147483648, 2147483647, 'ListNode value'));
    return;
  }
  if (type.kind === 'tree-node') {
    if (value === null) { writer.int32(-1); return; }
    let rawValues: unknown;
    if (Array.isArray(value)) {
      rawValues = value;
    } else if (typeof value === 'object') {
      const values: unknown[] = [];
      const nodes: unknown[] = [value];
      for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index];
        if (node === null) { values.push(null); continue; }
        if (typeof node !== 'object') throw new TypeError('TraceCLR TreeNode nodes must be objects or null.');
        const typed = node as { val?: unknown; value?: unknown; left?: unknown; right?: unknown };
        values.push(typed.val ?? typed.value);
        nodes.push(typed.left ?? null, typed.right ?? null);
        if (nodes.length > TRACECLR_WIRE_LIMITS.maxCollectionItems) throw new RangeError('TraceCLR TreeNode is too large.');
      }
      while (values.at(-1) === null) values.pop();
      rawValues = values;
    } else {
      throw new TypeError('TraceCLR TreeNode inputs must be level-order arrays or node objects.');
    }
    const values = collection(rawValues, false);
    writer.int32(values.length);
    for (const item of values) {
      writer.uint8(item === null ? 0 : 1);
      if (item !== null) writer.int32(integer(item, -2147483648, 2147483647, 'TreeNode value'));
    }
    return;
  }
  switch (type.name) {
    case 'void': return;
    case 'null': if (value !== null) throw new TypeError('TraceCLR null result must be null.'); writer.uint8(0); return;
    case 'bool': if (typeof value !== 'boolean') throw new TypeError('bool must be boolean.'); writer.uint8(value ? 1 : 0); return;
    case 'char': {
      if (typeof value !== 'string' || [...value].length !== 1 || value.charCodeAt(0) > 0xffff) throw new TypeError('char must be one UTF-16 code unit.');
      writer.uint16(value.charCodeAt(0)); return;
    }
    case 'uint8': writer.uint8(integer(value, 0, 255, 'uint8')); return;
    case 'int8': writer.int8(integer(value, -128, 127, 'int8')); return;
    case 'int16': writer.int16(integer(value, -32768, 32767, 'int16')); return;
    case 'uint16': writer.uint16(integer(value, 0, 65535, 'uint16')); return;
    case 'int32': writer.int32(integer(value, -2147483648, 2147483647, 'int32')); return;
    case 'uint32': writer.uint32(integer(value, 0, 4294967295, 'uint32')); return;
    case 'int64': writer.int64(integer64(value, true)); return;
    case 'uint64': writer.uint64(integer64(value, false)); return;
    case 'float32': if (typeof value !== 'number') throw new TypeError('float32 must be numeric.'); writer.float32(value); return;
    case 'float64': if (typeof value !== 'number') throw new TypeError('float64 must be numeric.'); writer.float64(value); return;
    case 'string': {
      if (value === null) { writer.int32(-1); return; }
      if (typeof value !== 'string') throw new TypeError('string must be a string or null.');
      const bytes = new TextEncoder().encode(value);
      writer.int32(bytes.byteLength); writer.bytes(bytes); return;
    }
  }
}

function readLength(reader: WireReader): number | null {
  const length = reader.int32();
  if (length === -1) return null;
  if (length < 0 || length > TRACECLR_WIRE_LIMITS.maxCollectionItems) {
    throw new RangeError(`Invalid TraceCLR collection length: ${length}.`);
  }
  return length;
}

function readValue(reader: WireReader, type: WireType, depth: number): unknown {
  if (depth > TRACECLR_WIRE_LIMITS.maxDepth) throw new RangeError('TraceCLR value is too deeply nested.');
  if (type.kind === 'container') {
    const length = readLength(reader);
    if (length === null) return null;
    const values = Array.from({ length }, () => readValue(reader, type.element, depth + 1));
    return type.name === 'set' ? new Set(values) : values;
  }
  if (type.kind === 'list-node') {
    const length = readLength(reader);
    return length === null ? null : Array.from({ length }, () => reader.int32());
  }
  if (type.kind === 'tree-node') {
    const length = readLength(reader);
    if (length === null) return null;
    const values = Array.from({ length }, () => reader.uint8() === 0 ? null : reader.int32());
    while (values.at(-1) === null) values.pop();
    return values;
  }
  switch (type.name) {
    case 'void': return undefined;
    case 'null': if (reader.uint8() !== 0) throw new RangeError('Invalid TraceCLR null marker.'); return null;
    case 'bool': { const value = reader.uint8(); if (value > 1) throw new RangeError('Invalid TraceCLR bool.'); return value === 1; }
    case 'char': return String.fromCharCode(reader.uint16());
    case 'uint8': return reader.uint8();
    case 'int8': return reader.int8();
    case 'int16': return reader.int16();
    case 'uint16': return reader.uint16();
    case 'int32': return reader.int32();
    case 'uint32': return reader.uint32();
    case 'int64': return reader.int64();
    case 'uint64': return reader.uint64();
    case 'float32': return reader.float32();
    case 'float64': return reader.float64();
    case 'string': {
      const length = readLength(reader);
      return length === null ? null : new TextDecoder('utf-8', { fatal: true }).decode(reader.bytes(length));
    }
  }
}

function begin(writer: WireWriter): void { writer.uint32(WIRE_MAGIC); }
function verify(reader: WireReader): void {
  if (reader.uint32() !== WIRE_MAGIC) throw new RangeError('TraceCLR wire magic/version mismatch.');
}

export function encodeTraceClrWireInputs(
  contract: TraceClrWireContractDescriptor,
  inputs: Readonly<Record<string, unknown>>,
): Uint8Array {
  const writer = new WireWriter();
  begin(writer);
  writer.uint16(contract.parameters.length);
  for (const parameter of contract.parameters) {
    if (!Object.prototype.hasOwnProperty.call(inputs, parameter.name)) {
      throw new TypeError(`Missing TraceCLR input: ${parameter.name}`);
    }
    writeValue(writer, parseWireType(parameter.type.wireType), inputs[parameter.name], 0);
  }
  return writer.finish();
}

export function decodeTraceClrWireInputs(
  contract: TraceClrWireContractDescriptor,
  bytes: Uint8Array,
): Record<string, unknown> {
  const reader = new WireReader(bytes);
  verify(reader);
  const count = reader.uint16();
  if (count !== contract.parameters.length) throw new RangeError(`TraceCLR parameter count mismatch: ${count}.`);
  const inputs: Record<string, unknown> = {};
  for (const parameter of contract.parameters) {
    inputs[parameter.name] = readValue(reader, parseWireType(parameter.type.wireType), 0);
  }
  reader.done();
  return inputs;
}

export function encodeTraceClrWireResult(
  contract: TraceClrWireContractDescriptor,
  value: unknown,
): Uint8Array {
  const writer = new WireWriter();
  begin(writer);
  writeValue(writer, parseWireType(contract.returnType.wireType), value, 0);
  return writer.finish();
}

export function decodeTraceClrWireResult(
  contract: TraceClrWireContractDescriptor,
  bytes: Uint8Array,
): unknown {
  const reader = new WireReader(bytes);
  verify(reader);
  const value = readValue(reader, parseWireType(contract.returnType.wireType), 0);
  reader.done();
  return value;
}
