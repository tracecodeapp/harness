import type {
  RuntimeFileEncoding,
} from "@tracecode/runtime-contracts";

import * as fflateModule from "fflate/browser";

import {
  JavaScriptProjectFile,
} from "../browser/contracts";

export const textEncoder = new TextEncoder();

export const textDecoder = new TextDecoder();

export const fflateRecord = fflateModule as unknown as Record<string, unknown>;

export const fflate = (
  typeof fflateRecord.gzipSync === 'function'
    ? fflateModule
    : fflateRecord.default
) as typeof fflateModule;

export function utf8Bytes(value: string): Uint8Array {
  return textEncoder.encode(value);
}

export function base64ToBytes(value: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(value, 'base64'));
  }

  const decoded = globalThis.atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

export function bytesToBase64(value: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value).toString('base64');
  }

  let binary = '';
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return globalThis.btoa(binary);
}

export function fileBytes(file: JavaScriptProjectFile): Uint8Array {
  return file.encoding === 'base64' ? base64ToBytes(file.contents) : utf8Bytes(file.contents);
}

export function byteEqual(left: Uint8Array | undefined, right: Uint8Array): boolean {
  if (!left || left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function bytesToRuntimeFile(path: string, contents: Uint8Array): JavaScriptProjectFile {
  const text = textDecoder.decode(contents);
  if (byteEqual(utf8Bytes(text), contents)) {
    return { path, contents: text };
  }
  return { path, contents: bytesToBase64(contents), encoding: 'base64' };
}

export function bytesFromNodeValue(value: unknown): Uint8Array {
  if (typeof value === 'string') return utf8Bytes(value);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  if (Array.isArray(value)) return new Uint8Array(value.map((item) => Number(item) & 0xff));
  return utf8Bytes(String(value));
}

export function requestedEncodingFromOptions(options?: string | { encoding?: string | null } | null): string | undefined {
  if (typeof options === 'string') return options;
  return typeof options?.encoding === 'string' ? options.encoding : undefined;
}

export function bytesFromFsWriteValue(value: unknown, options?: string | { encoding?: string | null } | null): Uint8Array {
  const encoding = requestedEncodingFromOptions(options);
  if (typeof value === 'string' && typeof encoding === 'string') {
    return BrowserBuffer.from(value, encoding);
  }
  return bytesFromNodeValue(value);
}

export function browserBufferFromBytes(value: Uint8Array): BrowserBuffer {
  return BrowserBuffer.from(value);
}

export function textFromBytes(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

export function bytesToRuntimeHttpBody(bytes: Uint8Array): { body: string; bodyEncoding?: RuntimeFileEncoding } {
  const text = textDecoder.decode(bytes);
  return byteEqual(utf8Bytes(text), bytes)
    ? { body: text }
    : { body: bytesToBase64(bytes), bodyEncoding: 'base64' };
}

export function bytesFromRuntimeHttpBody(message: { body?: string; bodyEncoding?: RuntimeFileEncoding }): Uint8Array {
  if (message.body === undefined) return new Uint8Array();
  return message.bodyEncoding === 'base64' ? base64ToBytes(message.body) : utf8Bytes(message.body);
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function bytesToHex(value: Uint8Array): string {
  return Array.from(value)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function hexToBytes(value: string): Uint8Array {
  const normalized = value.trim();
  const bytes = new Uint8Array(Math.ceil(normalized.length / 2));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2).padEnd(2, '0'), 16) & 0xff;
  }
  return bytes;
}

export class BrowserBuffer extends Uint8Array {
  static from(arrayLike: ArrayLike<number>): BrowserBuffer;
  static from<T>(arrayLike: ArrayLike<T>, mapfn: (value: T, index: number) => number, thisArg?: unknown): BrowserBuffer;
  static from(elements: Iterable<number>): BrowserBuffer;
  static from<T>(elements: Iterable<T>, mapfn?: (value: T, index: number) => number, thisArg?: unknown): BrowserBuffer;
  static from(value: string, encoding?: string): BrowserBuffer;
  static from(value: unknown, encodingOrMapfn?: string | ((value: unknown, index: number) => number), thisArg?: unknown): BrowserBuffer {
    if (typeof value === 'string') {
      const encoding = typeof encodingOrMapfn === 'string' ? encodingOrMapfn : undefined;
      if (encoding === 'base64') return new BrowserBuffer(base64ToBytes(value));
      if (encoding === 'hex') return new BrowserBuffer(hexToBytes(value));
      if (encoding === 'latin1' || encoding === 'binary') {
        return new BrowserBuffer(Array.from(value, (char) => char.charCodeAt(0) & 0xff));
      }
      return new BrowserBuffer(utf8Bytes(value));
    }
    if (typeof encodingOrMapfn === 'function' && value != null) {
      return new BrowserBuffer(Array.from(value as Iterable<unknown>, encodingOrMapfn, thisArg));
    }
    return new BrowserBuffer(bytesFromNodeValue(value));
  }

  static alloc(size: number, fill = 0): BrowserBuffer {
    const bytes = new BrowserBuffer(Math.max(0, Number(size) || 0));
    bytes.fill(Number(fill) & 0xff);
    return bytes;
  }

  static isBuffer(value: unknown): value is BrowserBuffer {
    return value instanceof BrowserBuffer;
  }

  static concat(values: readonly Uint8Array[]): BrowserBuffer {
    const totalLength = values.reduce((sum, value) => sum + value.byteLength, 0);
    const bytes = new BrowserBuffer(totalLength);
    let offset = 0;
    for (const value of values) {
      bytes.set(value, offset);
      offset += value.byteLength;
    }
    return bytes;
  }

  static byteLength(value: unknown, encoding?: string): number {
    if (typeof value === 'string') return BrowserBuffer.from(value, encoding).byteLength;
    return bytesFromNodeValue(value).byteLength;
  }

  toString(encoding = 'utf8'): string {
    if (encoding === 'base64') return bytesToBase64(this);
    if (encoding === 'hex') return bytesToHex(this);
    if (encoding === 'latin1' || encoding === 'binary') {
      return Array.from(this, (byte) => String.fromCharCode(byte)).join('');
    }
    return textFromBytes(this);
  }
}

export function createZlibApi() {
  return {
    gzipSync: (input: unknown) => browserBufferFromBytes(fflate.gzipSync(bytesFromNodeValue(input))),
    gunzipSync: (input: unknown) => browserBufferFromBytes(fflate.gunzipSync(bytesFromNodeValue(input))),
    deflateSync: (input: unknown) => browserBufferFromBytes(fflate.deflateSync(bytesFromNodeValue(input))),
    inflateSync: (input: unknown) => browserBufferFromBytes(fflate.inflateSync(bytesFromNodeValue(input))),
  };
}
