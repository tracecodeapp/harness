#!/usr/bin/env npx tsx

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const protocolVersion = 'tracecode-python-runtime-image-v1';
const expectedInputSha256 =
  '718d40f1c015dd25ec724cc8fc4e2325d6a45a92ae225121ff6953f224a16f72';
const [inputArgument, outputArgument] = process.argv.slice(2);

if (!inputArgument || !outputArgument) {
  throw new Error(
    'Usage: build-python-runtime-image-loader.ts <pinned-pyodide.js> <output-pyodide.js>'
  );
}

const inputPath = resolve(inputArgument);
const outputPath = resolve(outputArgument);
const loader = await readFile(inputPath, 'utf8');
const inputSha256 = createHash('sha256').update(loader).digest('hex');
if (inputSha256 !== expectedInputSha256) {
  throw new Error(
    `Pinned Pyodide 0.29.3 loader hash ${inputSha256} did not match ${expectedInputSha256}.`
  );
}
const settingsMarker = 'instantiateWasm:xe(e.indexURL)';
const fetchMarker =
  'let{binary:t,response:n}=A(e+"pyodide.asm.wasm"),i=Z();';
const instantiateMarker =
  'n?s=await WebAssembly.instantiateStreaming(n,a):s=await WebAssembly.instantiate(await t,a);';

for (const marker of [settingsMarker, fetchMarker, instantiateMarker]) {
  const occurrences = loader.split(marker).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `Pinned Pyodide loader is incompatible with ${protocolVersion}; expected one marker, found ${occurrences}: ${marker}`
    );
  }
}

const output = loader
  .replace(
    settingsMarker,
    'instantiateWasm:xe(e._compiledWasmModule??e.indexURL)'
  )
  .replace(
    fetchMarker,
    'let{binary:t,response:n}=e instanceof WebAssembly.Module?{}:A(e+"pyodide.asm.wasm"),i=Z();'
  )
  .replace(
    instantiateMarker,
    'e instanceof WebAssembly.Module?s={instance:await WebAssembly.instantiate(e,a),module:e}:n?s=await WebAssembly.instantiateStreaming(n,a):s=await WebAssembly.instantiate(await t,a);'
  )
  .concat(
    `\nglobalThis.__TRACECODE_PYTHON_RUNTIME_IMAGE_PROTOCOL__=${JSON.stringify(protocolVersion)};\n`
  );

await writeFile(outputPath, output, 'utf8');
console.log(JSON.stringify({
  schema: 'tracecode.python-runtime-image-loader-build.v1',
  protocolVersion,
  inputPath,
  inputSha256,
  outputPath,
  outputBytes: Buffer.byteLength(output),
  outputSha256: createHash('sha256').update(output).digest('hex'),
}, null, 2));
