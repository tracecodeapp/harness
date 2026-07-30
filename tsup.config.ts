import { defineConfig } from 'tsup';
import { commonConfig, libraryConfig } from './tsup.shared';

export default defineConfig([
  {
    ...commonConfig,
    // The root @tracecode/harness bundle stays self-contained: inline runtime-contracts
    // rather than leaving a bare @tracecode/runtime-contracts import the packed tarball
    // cannot resolve. Cross-copy token identity is preserved by the globalThis
    // Symbol.for registry in runtime-contracts.
    noExternal: [
      ...commonConfig.noExternal,
      '@tracecode/runtime-browser',
      '@tracecode/runtime-contracts',
      '@tracecode/tracejvm',
      '@tracecode/tracekernel',
    ],
    entry: {
      tracekernel: 'src/tracekernel.ts',
      // Build-only declaration closure for the two public entrypoints.
      // These files are deliberately absent from the package export map.
      core: 'packages/runtime-contracts/src/index.ts',
      'internal/tracekernel': 'packages/tracekernel/src/index.ts',
      'internal/tracekernel-workspace':
        'packages/tracekernel/src/workspace/index.ts',
      'internal/browser': 'packages/runtime-browser/src/internal.ts',
      judge: 'src/judge.ts',
      'zlib-browser-shim': 'packages/tracekernel/src/zlib-browser-shim.ts',
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
