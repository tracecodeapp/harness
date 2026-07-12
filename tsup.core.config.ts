import { defineConfig } from 'tsup';
import { commonConfig } from './tsup.shared';

export default defineConfig({
  ...commonConfig,
  entry: {
    index: 'packages/harness-core/src/index.ts',
  },
  outDir: 'packages/harness-core/dist',
});
