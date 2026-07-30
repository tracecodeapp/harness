import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    tracekernel: 'src/tracekernel.ts',
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
  bundle: true,
  splitting: true,
  skipNodeModulesBundle: true,
  external: [
    '@tracecode/tracekernel',
    'effect',
  ],
});
