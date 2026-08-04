#!/usr/bin/env npx tsx

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const ASSET_ROOT = resolve(
  process.cwd(),
  'workers',
  'python',
  'pyodide-0.29.3'
);

const EXPECTED = Object.freeze({
  'LICENSE.cpython.txt': {
    size: 13_809,
    sha256:
      '78b12c3a81360b357002334f0e70ea0e92eebf7a9b358805c03c48484945f3bb',
  },
  'LICENSE.pyodide.txt': {
    size: 16_725,
    sha256:
      '1f256ecad192880510e84ad60474eab7589218784b9a50bc7ceee34c2b91f1d5',
  },
  'pyodide.js': {
    size: 18_837,
    sha256:
      'f72b9ff060b14db597a9ae16069d9c8bafaed55c01cca3eb4ce5478f53e130f8',
  },
  'pyodide.asm.js': {
    size: 1_074_322,
    sha256:
      '1263f02b5b26099b96112378156f242dd98b39a8201ba7765e5fe3d455c5ce91',
  },
  'pyodide.asm.wasm': {
    size: 8_647_684,
    sha256:
      'e2f4ee75b325e35eb31bfb8c613d4dd5098f5502c156a97847686875b5025480',
  },
  'pyodide-lock.json': {
    size: 120_010,
    sha256:
      '3256ffc76388de0e37f4b34d42ab484268d1afc675179ff97b2a5bb14f84ccac',
  },
  'python_stdlib.zip': {
    size: 2_423_989,
    sha256:
      '4298b6ee445cb724c3973437da47789752b9e6ff4e26619026b283ec801fc46b',
  },
  'snapshots/chromium.bin': {
    size: 20_971_936,
    sha256:
      'f6e5a59006c18656d10b591681fe6bd009b7d1385ec395a3b0080d333bbb8151',
  },
  'snapshots/firefox.bin': {
    size: 20_971_936,
    sha256:
      'a334a4720d75dbc92c2062f41eb7cab2a1cd98192748ad09f43fd1ba5cce3ba9',
  },
  'snapshots/webkit.bin': {
    size: 20_971_936,
    sha256:
      'ebf430bc0a7a2408af4c736103fba70711058e0f9e60a890d50ed2e1d7076efb',
  },
});

let totalBytes = 0;
for (const [relativePath, expected] of Object.entries(EXPECTED)) {
  const bytes = await readFile(resolve(ASSET_ROOT, relativePath));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength !== expected.size || sha256 !== expected.sha256) {
    throw new Error(
      `Python runtime asset ${relativePath} does not match the 0.15 release ledger: ` +
        `expected ${expected.size} bytes/${expected.sha256}, received ` +
        `${bytes.byteLength} bytes/${sha256}.`
    );
  }
  totalBytes += bytes.byteLength;
}

console.log(
  `PASS: ${Object.keys(EXPECTED).length} Python runtime-image assets match ` +
    `${totalBytes} release-ledger bytes.`
);
