import {
  BrowserBuffer,
  browserBufferFromBytes,
  bytesToHex,
} from "../internal/encoding";

export function createCryptoApi() {
  const randomFill = (target: Uint8Array): Uint8Array => {
    const cryptoApi = globalThis.crypto;
    if (cryptoApi?.getRandomValues) {
      cryptoApi.getRandomValues(target);
      return target;
    }
    for (let index = 0; index < target.length; index += 1) {
      target[index] = Math.floor(Math.random() * 256);
    }
    return target;
  };
  return {
    randomUUID: (): string => globalThis.crypto?.randomUUID?.() ?? `${bytesToHex(randomFill(new Uint8Array(4)))}-${bytesToHex(randomFill(new Uint8Array(2)))}-4${bytesToHex(randomFill(new Uint8Array(2))).slice(1)}-8${bytesToHex(randomFill(new Uint8Array(2))).slice(1)}-${bytesToHex(randomFill(new Uint8Array(6)))}`,
    randomBytes: (size: number): BrowserBuffer => browserBufferFromBytes(randomFill(new Uint8Array(Math.max(0, Math.floor(Number(size) || 0))))),
    getRandomValues: <T extends Uint8Array>(array: T): T => randomFill(array) as T,
  };
}
