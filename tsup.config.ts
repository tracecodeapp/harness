import { defineConfig } from 'tsup';

const commonConfig = {
  format: ['esm', 'cjs'],
  dts: {
    compilerOptions: {
      module: 'esnext',
      moduleResolution: 'bundler',
    },
  },
  sourcemap: true,
  clean: true,
  target: 'es2022',
  splitting: false,
  bundle: true,
  banner: {
    js: 'var define = undefined;',
  },
  skipNodeModulesBundle: true,
  noExternal: ['just-bash', 'balanced-match', 'brace-expansion', 'diff', 'fflate', 'minimatch', 'sprintf-js', 'turndown'],
  external: ['typescript'],
} as const;

export default defineConfig([
  {
    ...commonConfig,
    entry: {
      index: 'src/index.ts',
      browser: 'packages/harness-browser/src/index.ts',
      'browser/project': 'packages/harness-browser/src/project.ts',
      project: 'packages/harness-project/src/index.ts',
      'project-node': 'src/project-node.ts',
      'internal/browser': 'packages/harness-browser/src/internal.ts',
      'zlib-browser-shim': 'packages/harness-project/src/zlib-browser-shim.ts',
      'async-hooks-browser-shim': 'packages/harness-project/src/async-hooks-browser-shim.ts',
      core: 'packages/harness-core/src/index.ts',
      python: 'packages/harness-python/src/index.ts',
      javascript: 'packages/harness-javascript/src/index.ts',
      java: 'packages/harness-java/src/index.ts',
      csharp: 'packages/harness-csharp/src/index.ts',
      cpp: 'packages/harness-cpp/src/index.ts',
      cli: 'src/cli.ts',
    },
  },
  {
    ...commonConfig,
    entry: {
      index: 'packages/harness-core/src/index.ts',
    },
    outDir: 'packages/harness-core/dist',
  },
  {
    ...commonConfig,
    entry: {
      index: 'packages/harness-browser/src/index.ts',
      internal: 'packages/harness-browser/src/internal.ts',
      project: 'packages/harness-browser/src/project.ts',
      'zlib-browser-shim': 'packages/harness-project/src/zlib-browser-shim.ts',
      'async-hooks-browser-shim': 'packages/harness-project/src/async-hooks-browser-shim.ts',
    },
    outDir: 'packages/harness-browser/dist',
  },
  {
    ...commonConfig,
    entry: {
      index: 'packages/harness-python/src/index.ts',
      'project-node': 'packages/harness-python/src/project-node.ts',
      'project-browser': 'packages/harness-python/src/project-browser.ts',
    },
    outDir: 'packages/harness-python/dist',
  },
  {
    ...commonConfig,
    entry: {
      index: 'packages/harness-javascript/src/index.ts',
      'project-node': 'packages/harness-javascript/src/project-node.ts',
      'project-browser': 'packages/harness-javascript/src/project-browser.ts',
    },
    outDir: 'packages/harness-javascript/dist',
  },
  {
    ...commonConfig,
    entry: {
      index: 'packages/harness-java/src/index.ts',
      'project-node': 'packages/harness-java/src/project-node.ts',
      'project-browser': 'packages/harness-java/src/project-browser.ts',
    },
    outDir: 'packages/harness-java/dist',
  },
  {
    ...commonConfig,
    entry: {
      index: 'packages/harness-csharp/src/index.ts',
      'project-node': 'packages/harness-csharp/src/project-node.ts',
      'project-browser': 'packages/harness-csharp/src/project-browser.ts',
    },
    outDir: 'packages/harness-csharp/dist',
  },
  {
    ...commonConfig,
    entry: {
      index: 'packages/harness-cpp/src/index.ts',
      'project-node': 'packages/harness-cpp/src/project-node.ts',
      'project-browser': 'packages/harness-cpp/src/project-browser.ts',
    },
    outDir: 'packages/harness-cpp/dist',
  },
  {
    ...commonConfig,
    entry: {
      index: 'packages/harness-project/src/index.ts',
      'zlib-browser-shim': 'packages/harness-project/src/zlib-browser-shim.ts',
      'async-hooks-browser-shim': 'packages/harness-project/src/async-hooks-browser-shim.ts',
    },
    outDir: 'packages/harness-project/dist',
  },
]);
