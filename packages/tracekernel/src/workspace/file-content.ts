import type { RuntimeFile, RuntimeFileEncoding } from '@tracecode/harness-core';
import type { FileContent } from 'just-bash/browser';


export function assertSupportedEncoding(encoding: RuntimeFileEncoding | undefined): RuntimeFileEncoding {
  return encoding ?? 'utf8';
}


export function normalizeRuntimeFileEncoding(encoding: RuntimeFileEncoding | undefined, label: string): RuntimeFileEncoding {
  if (encoding === undefined || encoding === 'utf8') return 'utf8';
  if (encoding === 'base64') return 'base64';
  throw new Error(`${label}.encoding must be "utf8" or "base64".`);
}


export function bytesFromBase64(value: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value, 'base64');
  }

  const decoded = globalThis.atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}


export function base64FromBytes(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }

  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return globalThis.btoa(binary);
}


export function textToByteString(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let byteString = '';
  for (const byte of bytes) {
    byteString += String.fromCharCode(byte);
  }
  return byteString;
}


export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}


export function contentToText(content: FileContent): string {
  if (typeof content === 'string') return content;
  return decodeUtf8(content) ?? Array.from(content, (byte) => String.fromCharCode(byte)).join('');
}


export function contentToBytes(content: FileContent): Uint8Array {
  return typeof content === 'string' ? new TextEncoder().encode(content) : content;
}


export function contentToBytesForRuntimeFile(file: RuntimeFile): Uint8Array {
  return (file.encoding ?? 'utf8') === 'base64'
    ? bytesFromBase64(file.contents)
    : new TextEncoder().encode(file.contents);
}


export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
