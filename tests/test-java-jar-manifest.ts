#!/usr/bin/env npx tsx

import assert from 'node:assert/strict';
import test from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import { extractJarMainClass } from '../packages/harness-project/src/arg-parsers';

const manifest = strToU8([
  'Manifest-Version: 1.0',
  'Main-Class: example.Main',
  '',
  '',
].join('\r\n'));

test('extracts Main-Class from an ordinary compressed JAR manifest', () => {
  const jar = zipSync({
    'META-INF/MANIFEST.MF': manifest,
    'example/Main.class': new Uint8Array([0xca, 0xfe, 0xba, 0xbe]),
  }, { level: 6 });
  assert.equal(extractJarMainClass(jar), 'example.Main');
});

test('extracts Main-Class from a stored JAR manifest', () => {
  const jar = zipSync({
    'META-INF/MANIFEST.MF': manifest,
  }, { level: 0 });
  assert.equal(extractJarMainClass(jar), 'example.Main');
});

test('returns null for JARs without a Main-Class', () => {
  const jar = zipSync({
    'META-INF/MANIFEST.MF': strToU8('Manifest-Version: 1.0\r\n\r\n'),
  });
  assert.equal(extractJarMainClass(jar), null);
});

test('rejects malformed and oversized manifest archives', () => {
  assert.equal(extractJarMainClass(new Uint8Array([1, 2, 3])), null);
  const jar = zipSync({
    'META-INF/MANIFEST.MF': new Uint8Array(1024 * 1024 + 1),
  });
  assert.equal(extractJarMainClass(jar), null);
});
