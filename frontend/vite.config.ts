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
  // reducerVersion 注入（与后端 config.reducerVersion 对齐；生产构建时改为包版本+git sha）
  define: {
    __DL_REDUCER_VERSION__: JSON.stringify(process.env.DL_REDUCER_VERSION ?? 'dev-0.1.0'),
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/static': 'http://localhost:3000',
      '/ws': { target: 'http://localhost:3000', ws: true },
    },
  },
});
