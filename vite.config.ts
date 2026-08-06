import { defineConfig } from 'vite';

export default defineConfig({
  worker: {
    // The decode worker uses ES module imports for libheif.
    format: 'es',
  },
  build: {
    target: 'es2022',
    // The libheif wasm binary is inlined as base64 inside its JS bundle, so the
    // worker chunk is legitimately ~2MB. Silence the size warning for it.
    chunkSizeWarningLimit: 3000,
  },
  server: {
    port: 5180,
  },
});
