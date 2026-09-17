import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@dl/shared': fileURLToPath(new URL('../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  define: {
    __DL_REDUCER_VERSION__: JSON.stringify(process.env.DL_REDUCER_VERSION ?? 'dev-0.1.0'),
  },
  server: {
    host: '0.0.0.0',      // 允许公网访问（浏览器要能连进来）
    port: 4097,           // 前端监听端口
    proxy: {
      '/api':    'http://localhost:4096',
      '/static': 'http://localhost:4096',
      '/ws':     { target: 'http://localhost:4096', ws: true },
    },
  },
});
