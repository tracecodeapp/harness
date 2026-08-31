import { gzipSync } from 'node:zlib';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const entries = [resolve('packages/runtime-browser/dist/project.js')];
const MAX_STATIC_RAW_BYTES = 350 * 1024;
const MAX_STATIC_GZIP_BYTES = 90 * 1024;
const FORBIDDEN_INITIAL_MARKERS = [
  'just-bash/dist/bundle/browser.js',
  'typescriptProjectLibFiles',
  'lib.es5.d.ts',
];

function staticModuleGraph(entry) {
  const pending = [entry];
  const visited = new Set();
  while (pending.length > 0) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, 'utf8');
    const importPattern = /(?:^|\n)import\s+(?:["'](\.[^"']+)["']|[\s\S]*?\sfrom\s+["'](\.[^"']+)["']);/gu;
    for (const match of source.matchAll(importPattern)) {
      pending.push(resolve(dirname(file), match[1] ?? match[2]));
    }
  }
  return visited;
}

for (const entry of entries) {
  const graph = staticModuleGraph(entry);
  const sources = Array.from(graph, (file) => readFileSync(file));
  const rawBytes = Array.from(graph, (file) => statSync(file).size).reduce((sum, size) => sum + size, 0);
  const gzipBytes = sources.reduce((sum, source) => sum + gzipSync(source).byteLength, 0);
  const combined = Buffer.concat(sources).toString('utf8');
  if (rawBytes > MAX_STATIC_RAW_BYTES || gzipBytes > MAX_STATIC_GZIP_BYTES) {
    throw new Error(
      `${entry} static graph exceeded its browser budget: ${rawBytes} raw / ${gzipBytes} gzip bytes ` +
        `(limits: ${MAX_STATIC_RAW_BYTES} / ${MAX_STATIC_GZIP_BYTES}).`
    );
  }
  for (const marker of FORBIDDEN_INITIAL_MARKERS) {
    if (combined.includes(marker)) {
      throw new Error(`${entry} eagerly includes deferred browser-project payload marker ${JSON.stringify(marker)}.`);
    }
  }
  if (!readFileSync(entry, 'utf8').includes('import(')) {
    throw new Error(`${entry} must retain dynamic provider/runtime imports.`);
  }
  console.log(
    `PASS: ${entry} static browser graph is ${rawBytes} raw / ${gzipBytes} gzip bytes across ${graph.size} modules`
  );
}
