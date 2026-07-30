import { defineConfig } from 'tsup';
import { commonConfig } from './tsup.shared';

export default defineConfig({
  ...commonConfig,
  entry: {
    index: 'packages/runtime-contracts/src/index.ts',
  },
  outDir: 'packages/runtime-contracts/dist',
});
