import { defineConfig } from 'vite';

export default defineConfig({
  // Served from a subfolder on the VPS (kevinvarghese.in/heic/) but from the
  // root in dev, so the prefix is a build input rather than a hardcoded path.
  // Everything downstream reads it back off `import.meta.env.BASE_URL`.
  base: process.env.APP_BASE ?? '/',
  optimizeDeps: {
    // The ONNX runtime loads its own wasm glue by dynamic import at runtime.
    // Letting Vite pre-bundle it rewrites those specifiers with `?import`,
    // which then 404s against the copies in `public/ort/`.
    exclude: ['onnxruntime-web'],
  },
  plugins: [
    {
      // Belt and braces for the same problem: anything Vite still tags with
      // `?import` under /ort/ is a plain static asset, so serve it as one.
      name: 'ort-static-assets',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url?.startsWith('/ort/')) req.url = req.url.split('?')[0];
          next();
        });
      },
    },
  ],
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
