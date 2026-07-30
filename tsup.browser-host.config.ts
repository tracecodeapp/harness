import { defineConfig } from 'tsup';
import { libraryConfig } from './tsup.shared';

export default defineConfig({
  ...libraryConfig,
  entry: {
    index: 'packages/harness-browser/src/index.ts',
    internal: 'packages/harness-browser/src/internal.ts',
    project: 'packages/harness-browser/src/project.ts',
    'zlib-browser-shim': 'packages/harness-project/src/zlib-browser-shim.ts',
  },
  outDir: 'packages/harness-browser/dist',
});
