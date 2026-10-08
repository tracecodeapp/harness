/** Recognize the sandboxed WASI preview1 command ABI used by TraceCC. */
export function isWasiCommandExecutable(bytes: Uint8Array): boolean {
  const header = [0, 97, 115, 109, 1, 0, 0, 0];
  if (!header.every((byte, index) => bytes[index] === byte)) return false;
  try {
    // Validation never instantiates the module or runs guest code. Untrusted
    // bytes cannot request arbitrary host imports through restored dispatch.
    const module = new WebAssembly.Module(bytes as BufferSource);
    const imports = WebAssembly.Module.imports(module);
    const exports = WebAssembly.Module.exports(module);
    return imports.every((entry) => entry.module === 'wasi_snapshot_preview1' && entry.kind === 'function') &&
      exports.some((entry) => entry.name === '_start' && entry.kind === 'function') &&
      exports.some((entry) => entry.name === 'memory' && entry.kind === 'memory');
  } catch {
    return false;
  }
}
