// 演示回放读取：POST { filename } → backend/static/demo/<filename>.json
// 回放素材公开，不做登录校验；文件名严格白名单 + realpath 防路径穿越。
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { ERROR_CODES, validateDemoReplayFile } from '@dl/shared';
import type { DemoReplayFile } from '@dl/shared';
import { fail, ok } from '../utils/respond.js';

/** 单文件读取上限；255×255 初态 + 大量意图也足够 */
const DEMO_REPLAY_MAX_BYTES = 64 * 1024 * 1024;

/** 去掉可选的 .json 后缀并校验；返回 null 表示非法 */
function normalizeFilename(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 84) return null;
  const name = trimmed.toLowerCase().endsWith('.json') ? trimmed.slice(0, -5) : trimmed;
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(name)) return null;
  if (name.includes('..')) return null;
  return name;
}

export const demoRoutes: FastifyPluginAsync = async (app) => {
  app.post('/api/demo/replay', async (request, reply) => {
    const body = (request.body ?? {}) as { filename?: unknown };
    const filename = normalizeFilename(body.filename);
    if (!filename) {
      return fail(reply, 400, ERROR_CODES.INVALID_PARAMS, 'filename 仅允许字母/数字/点/下划线/连字符');
    }

    let demoRoot: string;
    try {
      demoRoot = await realpath(app.demoDir);
    } catch {
      return fail(reply, 404, ERROR_CODES.DEMO_REPLAY_NOT_FOUND, '演示回放目录不存在');
    }

    let file: string;
    try {
      file = await realpath(path.join(demoRoot, `${filename}.json`));
    } catch {
      return fail(reply, 404, ERROR_CODES.DEMO_REPLAY_NOT_FOUND, `演示回放 ${filename}.json 不存在`);
    }
    if (!file.startsWith(demoRoot + path.sep)) {
      return fail(reply, 400, ERROR_CODES.INVALID_PARAMS, 'filename 非法');
    }

    let size: number;
    try {
      size = (await stat(file)).size;
    } catch {
      return fail(reply, 404, ERROR_CODES.DEMO_REPLAY_NOT_FOUND, `演示回放 ${filename}.json 不存在`);
    }
    if (size > DEMO_REPLAY_MAX_BYTES) {
      return fail(
        reply,
        413,
        ERROR_CODES.DEMO_REPLAY_TOO_LARGE,
        `演示回放超过 ${Math.floor(DEMO_REPLAY_MAX_BYTES / 1024 / 1024)}MB 上限`,
      );
    }

    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      return fail(reply, 400, ERROR_CODES.INVALID_PARAMS, '演示回放不是合法 JSON');
    }
    if (!validateDemoReplayFile(raw)) {
      return fail(reply, 400, ERROR_CODES.INVALID_PARAMS, '演示回放结构非法');
    }

    reply.header('Cache-Control', 'no-store');
    return ok(reply, raw as DemoReplayFile);
  });
};
