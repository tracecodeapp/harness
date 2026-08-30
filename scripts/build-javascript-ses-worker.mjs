import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const legacyWorkerPath = resolve(root, 'workers/javascript/javascript-worker.js');
const legacyWorker = await readFile(legacyWorkerPath, 'utf8');

function sliceBetween(start, end) {
  const startIndex = legacyWorker.indexOf(start);
  const endIndex = legacyWorker.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
    throw new Error(`Unable to extract JavaScript trace runtime between ${start} and ${end}.`);
  }
  return legacyWorker.slice(startIndex, endIndex).trim();
}

const serializationSource = sliceBetween(
  'function isLikelyTreeNodeValue',
  'function extractUserErrorLine'
);
const recorderSource = sliceBetween(
  'function getNumericOption',
  'function escapeRegExp'
);
const traceValueLookupSource = sliceBetween(
  'function valueAtPath',
  'function getTypeScriptCompiler'
);
const helperLiteralStart = 'const TRACING_RUNTIME_HELPERS_SOURCE = `';
const helperStart = legacyWorker.indexOf(helperLiteralStart);
const helperEnd = legacyWorker.indexOf(
  '\n`;\n\nfunction getTracingRuntimeHelpersSource',
  helperStart + helperLiteralStart.length
);
if (helperStart < 0 || helperEnd < 0) {
  throw new Error('Unable to extract the JavaScript tracing helper runtime.');
}
const tracingHelpersSource = legacyWorker.slice(
  helperStart + helperLiteralStart.length,
  helperEnd
);
const traceRuntimeSupportSource = [
  "const RUNTIME_TRACE_SCHEMA_VERSION = 'runtime-trace-2026-04-28';",
  serializationSource,
  recorderSource,
  traceValueLookupSource,
].join('\n\n');

await build({
  entryPoints: [
    resolve(root, 'packages/runtime-javascript/src/ses-algorithm-worker-entry.ts'),
  ],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  outfile: resolve(root, 'workers/javascript/javascript-ses-algorithm-worker.js'),
  define: {
    __TRACECODE_TRACE_RUNTIME_SUPPORT_SOURCE__: JSON.stringify(
      traceRuntimeSupportSource
    ),
    __TRACECODE_TRACE_RUNTIME_HELPERS_SOURCE__: JSON.stringify(
      tracingHelpersSource
    ),
  },
});
