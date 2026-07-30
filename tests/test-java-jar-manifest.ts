#!/usr/bin/env npx tsx

import assert from 'node:assert/strict';
import test from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import { extractJarMainClass } from '../packages/tracekernel/src/workspace/arg-parsers';

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

test('rejects compressed manifests whose declared size does not match their DEFLATE stream', () => {
  const jar = zipSync({
    'META-INF/MANIFEST.MF': manifest,
  }, { level: 6 });
  const centralDirectorySignature = new Uint8Array([0x50, 0x4b, 0x01, 0x02]);
  const centralDirectoryOffset = jar.findIndex((byte, index) =>
    centralDirectorySignature.every((signatureByte, signatureIndex) =>
      jar[index + signatureIndex] === signatureByte
    )
  );
  assert.notEqual(centralDirectoryOffset, -1);

  const malformedJar = jar.slice();
  const declaredSizeOffset = centralDirectoryOffset + 24;
  malformedJar[declaredSizeOffset] = manifest.byteLength - 1;
  malformedJar[declaredSizeOffset + 1] = 0;
  malformedJar[declaredSizeOffset + 2] = 0;
  malformedJar[declaredSizeOffset + 3] = 0;

  assert.equal(extractJarMainClass(malformedJar), null);
});
