import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: {
    headers: crossOriginIsolationHeaders,
  },
  preview: {
    headers: crossOriginIsolationHeaders,
  },
  resolve: {
    alias: {
      'node:zlib': fileURLToPath(new URL('./src/node-zlib-shim.ts', import.meta.url)),
      zlib: fileURLToPath(new URL('./src/node-zlib-shim.ts', import.meta.url)),
    },
  },
});
