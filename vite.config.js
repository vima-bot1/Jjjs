import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Single-thread ffmpeg core: no SharedArrayBuffer / COOP+COEP headers required.
export default defineConfig({
  plugins: [react()],
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/core'] },
  worker: { format: 'es' },
});
