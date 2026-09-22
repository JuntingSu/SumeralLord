import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TRAIN_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** demo-saver：仅 dev 模式写盘通道——浏览器把示范 JSON POST 到 /api/demo，落盘 train/demos/demo-<ts>.json。
 *  构建产物（vite preview）无此端点（示范功能需 npm run dev 使用，见 README）。 */
const demoSaver: Plugin = {
  name: 'demo-saver',
  configureServer(server) {
    server.middlewares.use('/api/demo', (req, res, next) => {
      if (req.method !== 'POST') return next();
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const demo = JSON.parse(body);
          const dir = path.join(TRAIN_ROOT, 'demos');
          fs.mkdirSync(dir, { recursive: true });
          const file = path.join(dir, `demo-${Date.now()}.json`);
          fs.writeFileSync(file, JSON.stringify(demo, null, 2));
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, file }));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false, error: String(e) }));
        }
      });
    });
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss(), demoSaver],
  resolve: {
    alias: {
      '@dl/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5180,
  },
});
