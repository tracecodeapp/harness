import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    browser: 'packages/harness-browser/src/index.ts',
    'internal/browser': 'packages/harness-browser/src/internal.ts',
    core: 'packages/harness-core/src/index.ts',
    python: 'packages/harness-python/src/index.ts',
    javascript: 'packages/harness-javascript/src/index.ts',
    cli: 'src/cli.ts',
  },
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
});
