import { defineConfig } from 'tsup';
import { commonConfig, libraryConfig } from './tsup.shared';

export default defineConfig([
  {
    ...commonConfig,
    // The root @tracecode/harness bundle stays self-contained: inline runtime-core
    // rather than leaving a bare @tracecode/runtime-core import the packed tarball
    // cannot resolve. Cross-copy token identity is preserved by the globalThis
    // Symbol.for registry in runtime-core.
    noExternal: [
      ...commonConfig.noExternal,
      '@tracecode/runtime-browser',
      '@tracecode/runtime-core',
      '@tracecode/tracekernel',
    ],
    entry: {
      index: 'src/index.ts',
      browser: 'src/browser.ts',
      'browser/project': 'packages/runtime-browser/src/project.ts',
      project: 'packages/workspace-facade/src/index.ts',
      'project-node': 'src/project-node.ts',
      native: 'src/native.ts',
      'internal/browser': 'packages/runtime-browser/src/internal.ts',
      'internal/tracekernel/workspace':
        'src/internal/tracekernel/workspace.ts',
      judge: 'src/judge.ts',
      'zlib-browser-shim': 'packages/workspace-facade/src/zlib-browser-shim.ts',
      core: 'packages/runtime-core/src/index.ts',
      python: 'packages/runtime-python/src/index.ts',
      javascript: 'packages/runtime-javascript/src/index.ts',
      java: 'packages/runtime-java/src/index.ts',
      csharp: 'packages/runtime-csharp/src/index.ts',
      cpp: 'packages/runtime-cpp/src/index.ts',
      sql: 'packages/runtime-sql/src/index.ts',
      cli: 'src/cli.ts',
    },
  },
  {
    ...libraryConfig,
    entry: {
      index: 'packages/runtime-python/src/index.ts',
      'project-node': 'packages/runtime-python/src/project-node.ts',
      'project-browser': 'packages/runtime-python/src/project-browser.ts',
    },
    outDir: 'packages/runtime-python/dist',
  },
  {
    ...libraryConfig,
    entry: {
      index: 'packages/runtime-javascript/src/index.ts',
      'project-node': 'packages/runtime-javascript/src/project-node.ts',
      'project-browser': 'packages/runtime-javascript/src/project-browser.ts',
    },
    outDir: 'packages/runtime-javascript/dist',
  },
  {
    ...libraryConfig,
    entry: {
      index: 'packages/runtime-java/src/index.ts',
      'project-node': 'packages/runtime-java/src/project-node.ts',
      'project-browser': 'packages/runtime-java/src/project-browser.ts',
      'java-project': 'packages/runtime-java/src/java-project.ts',
      'java-project-runtime': 'packages/runtime-java/src/java-project-runtime.ts',
    },
    outDir: 'packages/runtime-java/dist',
  },
  {
    ...libraryConfig,
    entry: {
      index: 'packages/runtime-csharp/src/index.ts',
      'project-node': 'packages/runtime-csharp/src/project-node.ts',
      'project-browser': 'packages/runtime-csharp/src/project-browser.ts',
    },
    outDir: 'packages/runtime-csharp/dist',
  },
  {
    ...libraryConfig,
    entry: {
      index: 'packages/runtime-cpp/src/index.ts',
      'project-node': 'packages/runtime-cpp/src/project-node.ts',
      'project-browser': 'packages/runtime-cpp/src/project-browser.ts',
    },
    outDir: 'packages/runtime-cpp/dist',
  },
  {
    ...libraryConfig,
    entry: {
      index: 'packages/workspace-facade/src/index.ts',
      'zlib-browser-shim': 'packages/workspace-facade/src/zlib-browser-shim.ts',
    },
    outDir: 'packages/workspace-facade/dist',
  },
  {
    ...libraryConfig,
    entry: {
      index: 'packages/runtime-native/src/index.ts',
    },
    outDir: 'packages/runtime-native/dist',
  },
  {
    ...commonConfig,
    entry: {
      index: 'packages/runtime-sql/src/index.ts',
    },
    outDir: 'packages/runtime-sql/dist',
  },
]);
