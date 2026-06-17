import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    exclude: ['@electric-sql/pglite'],
  },
  resolve: {
    alias: {
      '@tracecode/harness-sql': fileURLToPath(new URL('../../packages/harness-sql/src/index.ts', import.meta.url)),
    },
  },
});
