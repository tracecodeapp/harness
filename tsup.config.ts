import { defineConfig } from 'tsup';
import { commonConfig, libraryConfig } from './tsup.shared';

export default defineConfig([
  {
    ...commonConfig,
    // The root @tracecode/harness bundle stays self-contained: inline harness-core
    // rather than leaving a bare @tracecode/harness-core import the packed tarball
    // cannot resolve. Cross-copy token identity is preserved by the globalThis
    // Symbol.for registry in harness-core.
    noExternal: [
      ...commonConfig.noExternal,
      '@tracecode/harness-browser',
      '@tracecode/harness-core',
      '@tracecode/tracekernel',
    ],
    entry: {
      index: 'src/index.ts',
      browser: 'src/browser.ts',
      'browser/project': 'packages/harness-browser/src/project.ts',
      project: 'packages/harness-project/src/index.ts',
      'project-node': 'src/project-node.ts',
      native: 'src/native.ts',
      'internal/browser': 'packages/harness-browser/src/internal.ts',
      'internal/tracekernel/workspace':
        'src/internal/tracekernel/workspace.ts',
      'zlib-browser-shim': 'packages/harness-project/src/zlib-browser-shim.ts',
      core: 'packages/harness-core/src/index.ts',
      python: 'packages/harness-python/src/index.ts',
      javascript: 'packages/harness-javascript/src/index.ts',
      java: 'packages/harness-java/src/index.ts',
      csharp: 'packages/harness-csharp/src/index.ts',
      cpp: 'packages/harness-cpp/src/index.ts',
      sql: 'packages/runtime-sql/src/index.ts',
      cli: 'src/cli.ts',
    },
  },
  {
    ...libraryConfig,
    entry: {
      index: 'packages/harness-python/src/index.ts',
      'project-node': 'packages/harness-python/src/project-node.ts',
      'project-browser': 'packages/harness-python/src/project-browser.ts',
    },
    outDir: 'packages/harness-python/dist',
  },
  {
    ...libraryConfig,
    entry: {
      index: 'packages/harness-javascript/src/index.ts',
      'project-node': 'packages/harness-javascript/src/project-node.ts',
      'project-browser': 'packages/harness-javascript/src/project-browser.ts',
    },
    outDir: 'packages/harness-javascript/dist',
  },
  {
    ...libraryConfig,
    entry: {
      index: 'packages/harness-java/src/index.ts',
      'project-node': 'packages/harness-java/src/project-node.ts',
      'project-browser': 'packages/harness-java/src/project-browser.ts',
      'java-project': 'packages/harness-java/src/java-project.ts',
      'java-project-runtime': 'packages/harness-java/src/java-project-runtime.ts',
    },
    outDir: 'packages/harness-java/dist',
  },
  {
    ...libraryConfig,
    entry: {
      index: 'packages/harness-csharp/src/index.ts',
      'project-node': 'packages/harness-csharp/src/project-node.ts',
      'project-browser': 'packages/harness-csharp/src/project-browser.ts',
    },
    outDir: 'packages/harness-csharp/dist',
  },
  {
    ...libraryConfig,
    entry: {
      index: 'packages/harness-cpp/src/index.ts',
      'project-node': 'packages/harness-cpp/src/project-node.ts',
      'project-browser': 'packages/harness-cpp/src/project-browser.ts',
    },
    outDir: 'packages/harness-cpp/dist',
  },
  {
    ...libraryConfig,
    entry: {
      index: 'packages/harness-project/src/index.ts',
      'zlib-browser-shim': 'packages/harness-project/src/zlib-browser-shim.ts',
    },
    outDir: 'packages/harness-project/dist',
  },
  {
    ...libraryConfig,
    entry: {
      index: 'packages/harness-native/src/index.ts',
    },
    outDir: 'packages/harness-native/dist',
  },
  {
    ...commonConfig,
    entry: {
      index: 'packages/runtime-sql/src/index.ts',
    },
    outDir: 'packages/runtime-sql/dist',
  },
]);
