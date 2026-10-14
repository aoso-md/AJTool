import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The dev server proxies the backend, so `vite dev` is ALSO same-origin: the
// session cookie stays first-party locally exactly as on the deployed
// subdomain. Run the backend first (`pnpm dev` one folder up).
const BACKEND = 'http://localhost:8108';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: false },
      '/auth': { target: BACKEND, changeOrigin: false },
      '/health': { target: BACKEND, changeOrigin: false },
      '/ready': { target: BACKEND, changeOrigin: false },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
