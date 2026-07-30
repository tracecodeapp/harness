import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    exclude: ['@electric-sql/pglite'],
  },
  resolve: {
    alias: {
      '@tracecode/runtime-sql': fileURLToPath(new URL('../../packages/runtime-sql/src/index.ts', import.meta.url)),
    },
  },
});
