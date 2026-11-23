import strict from 'node:assert/strict';
import assert from 'node:assert';
import { appendSuiteEvent } from './suite-events.mjs';
import { syncBuiltinESMExports } from 'node:module';
import { isAbsolute, relative } from 'node:path';

const path = process.env.TRACECODE_SUITE_LEDGER;
const root = process.env.TRACECODE_SUITE_ROOT;
const nonce = process.env.TRACECODE_SUITE_NONCE;
const entry = process.argv[1];
const leaf = entry && root ? relative(root, entry) : '';
if (path && nonce && leaf && !leaf.startsWith('..') && !isAbsolute(leaf) && /(?:^|\/)tests\//u.test(leaf)) {
  function record(kind, details = {}) {
    appendSuiteEvent({ leaf, kind, ...details });
  }
  record('process-start');
  const assertions = new Map();
  // Node uses the identities of its match and rejection helpers internally.
  // Leave them intact. The instrumented leaves attest to these checks explicitly.
  for (const methods of new Set([assert, strict])) {
    for (const name of [
      'ok', 'equal', 'notEqual', 'strictEqual', 'notStrictEqual', 'deepEqual', 'notDeepEqual',
      'deepStrictEqual', 'notDeepStrictEqual', 'throws', 'doesNotThrow',
      'ifError', 'partialDeepStrictEqual',
    ]) {
      const original = methods[name];
      if (typeof original !== 'function') continue;
      methods[name] = function (...args) {
        const result = Reflect.apply(original, this, args);
        const stack = new Error().stack?.split('\n').slice(2) ?? [];
        const site = stack.find((line) => line.includes(entry));
        if (site) {
          const id = name + '@' + site.trim().replaceAll(root + '/', '');
          const observed = () => { assertions.set(id, (assertions.get(id) ?? 0) + 1); };
          if (result instanceof Promise) return result.then((value) => { observed(); return value; });
          observed();
        }
        return result;
      };
    }
  }
  syncBuiltinESMExports();
  process.once('exit', (code) => record('process-end', { code, assertions: [...assertions] }));
}
