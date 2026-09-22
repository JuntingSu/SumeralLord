import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** v2 训练根（本配置文件在 train/v2/replay-viewer/） */
const V2_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 写盘通道（仅 vite dev 模式；构建产物无这些端点，README 注明）：
 *  POST /api/demo    → v2/demos/demo-<ts>.json（示范/纠错）
 *  POST /api/pref    → v2/prefs/pref-<ts>.json（偏好判定）
 *  GET  /api/log/:gameId → v2/runs/logs/** 下按 gameId 返回对局日志（判题工作台取日志用） */
const saver: Plugin = {
  name: 'annotation-saver',
  configureServer(server) {
    server.middlewares.use('/api/demo', (req, res, next) => {
      if (req.method !== 'POST') return next();
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const demo = JSON.parse(body);
          const dir = path.join(V2_ROOT, 'demos');
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

    server.middlewares.use('/api/pref', (req, res, next) => {
      if (req.method !== 'POST') return next();
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const pref = JSON.parse(body);
          const dir = path.join(V2_ROOT, 'prefs');
          fs.mkdirSync(dir, { recursive: true });
          const file = path.join(dir, `pref-${Date.now()}.json`);
          fs.writeFileSync(file, JSON.stringify(pref, null, 2));
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, file }));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false, error: String(e) }));
        }
      });
    });

    server.middlewares.use('/api/log/', (req, res, next) => {
      const gameId = decodeURIComponent((req.url ?? '').replace(/^\//, ''));
      if (!gameId) return next();
      // 扫描 v2/runs/logs/round-*/game-<gameId>.jsonl
      const logsRoot = path.join(V2_ROOT, 'runs', 'logs');
      let hit: string | null = null;
      if (fs.existsSync(logsRoot)) {
        for (const roundDir of fs.readdirSync(logsRoot)) {
          const file = path.join(logsRoot, roundDir, `game-${gameId}.jsonl`);
          if (fs.existsSync(file)) {
            hit = file;
            break;
          }
        }
      }
      if (!hit) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: false, error: `log not found: ${gameId}` }));
        return;
      }
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(fs.readFileSync(hit, 'utf8'));
    });
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss(), saver],
  resolve: {
    alias: {
      '@dl/shared': fileURLToPath(new URL('../../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5180,
  },
});
