import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// TAURI_DEV_HOST 只在给手机调试时由 tauri CLI 设置
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
