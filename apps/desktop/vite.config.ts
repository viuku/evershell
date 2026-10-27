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
  // vite 按字面前缀匹配，不认通配符；写成 TAURI_ENV_* 时一个都传不进来（2026-10-28 发现）
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
