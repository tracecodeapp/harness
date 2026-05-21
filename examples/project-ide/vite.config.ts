import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: {
      'node:zlib': fileURLToPath(new URL('./src/node-zlib-shim.ts', import.meta.url)),
      zlib: fileURLToPath(new URL('./src/node-zlib-shim.ts', import.meta.url)),
    },
  },
});
