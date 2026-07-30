import { defineConfig } from 'tsup';
import { libraryConfig } from './tsup.shared';

export default defineConfig({
  ...libraryConfig,
  entry: {
    index: 'packages/runtime-browser/src/index.ts',
    internal: 'packages/runtime-browser/src/internal.ts',
    project: 'packages/runtime-browser/src/project.ts',
    'zlib-browser-shim': 'packages/tracekernel/src/zlib-browser-shim.ts',
  },
  outDir: 'packages/runtime-browser/dist',
});
