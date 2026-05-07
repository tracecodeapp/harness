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
  skipNodeModulesBundle: true,
  external: ['typescript'],
} as const;

export default defineConfig([
  {
    ...commonConfig,
    entry: {
      index: 'src/index.ts',
      browser: 'packages/harness-browser/src/index.ts',
      'internal/browser': 'packages/harness-browser/src/internal.ts',
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
    },
    outDir: 'packages/harness-browser/dist',
  },
  {
    ...commonConfig,
    entry: {
      index: 'packages/harness-python/src/index.ts',
    },
    outDir: 'packages/harness-python/dist',
  },
  {
    ...commonConfig,
    entry: {
      index: 'packages/harness-javascript/src/index.ts',
    },
    outDir: 'packages/harness-javascript/dist',
  },
  {
    ...commonConfig,
    entry: {
      index: 'packages/harness-java/src/index.ts',
    },
    outDir: 'packages/harness-java/dist',
  },
  {
    ...commonConfig,
    entry: {
      index: 'packages/harness-csharp/src/index.ts',
    },
    outDir: 'packages/harness-csharp/dist',
  },
  {
    ...commonConfig,
    entry: {
      index: 'packages/harness-cpp/src/index.ts',
    },
    outDir: 'packages/harness-cpp/dist',
  },
]);
