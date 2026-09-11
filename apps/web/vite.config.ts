import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The browser talks to /api on the same origin; Vite forwards it to the API
    // in development so there is nothing to configure by hand.
    proxy: { '/api': { target: process.env.API_URL || 'http://localhost:8080', changeOrigin: true } },
  },
  build: { outDir: 'dist', sourcemap: true },
});
