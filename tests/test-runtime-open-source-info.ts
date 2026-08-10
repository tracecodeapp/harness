#!/usr/bin/env npx tsx

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LANGUAGE_RUNTIME_OPEN_SOURCE_INFOS,
  SUPPORTED_LANGUAGES,
  getLanguageRuntimeOpenSourceInfo,
  getSupportedLanguageRuntimeOpenSourceInfos,
  resolveRuntimeOpenSourceResourceHref,
  type Language,
} from '../src/browser';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
const pyodidePackage = JSON.parse(readFileSync('node_modules/pyodide/package.json', 'utf8')) as {
  version: string;
  license: string;
};
const pyodideLock = JSON.parse(readFileSync('node_modules/pyodide/pyodide-lock.json', 'utf8')) as {
  info: { python: string };
};

const infos = getSupportedLanguageRuntimeOpenSourceInfos();
assert.deepEqual(
  infos.map((info) => info.language).sort(),
  [...SUPPORTED_LANGUAGES].sort(),
  'open-source metadata must cover every supported language'
);

for (const info of infos) {
  assert.ok(info.components.length > 0, `${info.language} must list at least one component`);
  for (const component of info.components) {
    assert.ok(component.name.length > 0, `${info.language} component must have a name`);
    assert.ok(component.license.length > 0, `${component.name} must expose an SPDX license`);
    assert.ok(component.resources.length > 0, `${component.name} must expose a legal/source resource`);
    for (const resource of component.resources) {
      assert.match(resource.href, /^(?:https?:\/\/|\/workers\/)/u, `${component.name} has an invalid resource URL`);
    }
  }
}

assert.equal(
  infos.flatMap((info) => info.components).some((component) => component.name === 'Effect'),
  false,
  'service-layer dependencies must not be presented as learner runtime components'
);

const python = getLanguageRuntimeOpenSourceInfo('python');
assert.deepEqual(
  python.components.map((component) => [component.name, component.version, component.license]),
  [
    ['CPython', pyodideLock.info.python, 'PSF-2.0'],
    ['Pyodide', pyodidePackage.version, pyodidePackage.license],
  ],
  'Python legal metadata must identify the actual runtime distribution'
);
assert.equal(
  python.components[1]?.resources.find((resource) => resource.kind === 'license')?.href,
  `/workers/python/pyodide-${pyodidePackage.version}/LICENSE.pyodide.txt`
);
assert.ok(
  python.components[1]?.resources.some(
    (resource) =>
      resource.kind === 'modifications' &&
      resource.href.includes(`/harness/tree/v${packageJson.version}/`)
  ),
  'Pyodide must link the Harness-owned runtime modifications for the release'
);

const java = getLanguageRuntimeOpenSourceInfo('java');
assert.ok(
  java.components.some(
    (component) =>
      component.name.includes('OpenJDK') &&
      component.resources.some((resource) => resource.kind === 'corresponding-source')
  ),
  'Java must expose OpenJDK corresponding source from the pinned TraceJVM release'
);
assert.ok(
  java.components
    .find((component) => component.name === 'TeaVM javac')
    ?.resources.some(
      (resource) =>
        resource.kind === 'license' && resource.href.includes('/tracecodeapp/tracejvm/blob/v')
    ),
  'TeaVM javac must use the license copy shipped with the pinned TraceJVM release'
);

const csharp = getLanguageRuntimeOpenSourceInfo('csharp');
const roslyn = csharp.components.find((component) => component.name === 'Roslyn C# compiler');
assert.ok(
  roslyn?.resources.some(
    (resource) =>
      resource.kind === 'package' &&
      resource.href === `https://www.nuget.org/packages/Microsoft.CodeAnalysis.CSharp/${roslyn.version}`
  ),
  'Roslyn must link the exact distributed package version instead of assuming a matching source tag'
);

const cpp = getLanguageRuntimeOpenSourceInfo('cpp');
assert.equal(
  cpp.components.find((component) => component.name === 'TraceCC')?.license,
  java.components.find((component) => component.name === 'TraceJVM')?.license,
  'learner-facing TraceCC and TraceJVM metadata must expose the same engine license policy'
);

const customPython = getLanguageRuntimeOpenSourceInfo('python', {
  assetBaseUrl: 'https://assets.example.test/runtime/',
});
assert.equal(
  customPython.components[0]?.resources.find((resource) => resource.kind === 'license')?.href,
  `https://assets.example.test/runtime/python/pyodide-${pyodidePackage.version}/LICENSE.cpython.txt`,
  'asset-backed links must honor the consumer runtime asset root'
);

const rawPython = LANGUAGE_RUNTIME_OPEN_SOURCE_INFOS.python;
const rawLicense = rawPython.components[0]?.resources.find((resource) => resource.kind === 'license');
assert.ok(rawLicense && 'assetPath' in rawLicense, 'generated metadata must retain portable asset paths');
assert.equal(
  resolveRuntimeOpenSourceResourceHref(rawLicense, { assetBaseUrl: '/custom-workers' }),
  `/custom-workers/python/pyodide-${pyodidePackage.version}/LICENSE.cpython.txt`
);

assert.throws(
  () => getLanguageRuntimeOpenSourceInfo('ruby' as Language),
  /Open-source runtime info for language "ruby" is not implemented yet/u
);

console.log('PASS: generated runtime open-source info is complete and asset-root portable');
