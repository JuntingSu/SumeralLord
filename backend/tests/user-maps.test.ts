// 个人作品 / 社区地图索引 / 点赞 接口测试
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

let app: FastifyInstance;
let dir: string;

function mapOf(title = '测试作品'): Record<string, unknown> {
  return {
    version: 1,
    title,
    description: 'desc',
    author: '原作者',
    timestamp: '2026-01-01 00:00:00.0',
    row: 2,
    column: 2,
    random_spawn: false,
    cylindrical_map: false,
    fog_mode: false,
    online_time_settings: { total_time: 600, round_time: 60, time_bonus: 0 },
    tags: ['2人', '测试'],
    player_num: 2,
    player_list: [
      { name: '红方', team: 1, computer: 255, seat: 1, flag: 1 },
      { name: '蓝方', team: 2, computer: 255, seat: 2, flag: 2 },
    ],
    battlefield: [
      [0, 1, 1],
      [0, 128, 0],
      [0, 2, 1],
      [0, 128, 0],
    ],
  };
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'dl-user-maps-'));
  app = await buildApp({
    dbPath: path.join(dir, 'test.db'),
    logger: false,
    staticRoot: path.join(dir, 'static'),
  });
});

afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

async function registerAndLogin(username: string): Promise<string> {
  await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password: 'password123' },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password: 'password123' },
  });
  return login.json().data.token as string;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe('个人作品', () => {
  it('创建后写入文件与索引，作者取当前账号；/static 不可直接访问', async () => {
    const token = await registerAndLogin('alice');
    const res = await app.inject({
      method: 'POST',
      url: '/api/user-maps',
      headers: auth(token),
      payload: { map: mapOf('我的第一张图') },
    });
    expect(res.statusCode).toBe(200);
    const meta = res.json().data;
    expect(meta.id).toMatch(/^um_/);
    expect(meta.author).toBe('alice');
    expect(meta.published).toBe(false);
    expect(existsSync(path.join(dir, 'static', 'user-maps', `${meta.id}.json`))).toBe(true);

    const direct = await app.inject({ method: 'GET', url: `/static/user-maps/${meta.id}.json` });
    expect(direct.statusCode).toBe(404);

    const list = await app.inject({ method: 'GET', url: '/api/user-maps', headers: auth(token) });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.total).toBe(1);
    expect(list.json().data.mapList[0].title).toBe('我的第一张图');
  });

  it('更新只允许作者本人，且更新搜索索引', async () => {
    const alice = await registerAndLogin('alice');
    const bob = await registerAndLogin('bob');
    const created = await app.inject({
      method: 'POST',
      url: '/api/user-maps',
      headers: auth(alice),
      payload: { map: mapOf('旧标题') },
    });
    const id = created.json().data.id as string;

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/user-maps/${id}`,
      headers: auth(alice),
      payload: { map: mapOf('新标题') },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().data.title).toBe('新标题');

    const forbidden = await app.inject({
      method: 'PUT',
      url: `/api/user-maps/${id}`,
      headers: auth(bob),
      payload: { map: mapOf('被改了') },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().code).toBe('FORBIDDEN');
  });

  it('搜索标题/tag，排序与分页', async () => {
    const token = await registerAndLogin('alice');
    for (const title of ['Charlie', 'Alpha', 'Bravo']) {
      await app.inject({
        method: 'POST',
        url: '/api/user-maps',
        headers: auth(token),
        payload: { map: mapOf(title) },
      });
    }
    const sorted = await app.inject({
      method: 'GET',
      url: '/api/user-maps?sort=title_asc&page=1&pageSize=2',
      headers: auth(token),
    });
    const data = sorted.json().data;
    expect(data.total).toBe(3);
    expect(data.mapList.map((m: { title: string }) => m.title)).toEqual(['Alpha', 'Bravo']);

    const searched = await app.inject({
      method: 'GET',
      url: `/api/user-maps?search=${encodeURIComponent('测试')}`,
      headers: auth(token),
    });
    expect(searched.json().data.total).toBe(3);
  });

  it('达到数量上限返回 USER_MAP_LIMIT', async () => {
    const limitedDir = mkdtempSync(path.join(tmpdir(), 'dl-user-maps-limit-'));
    const limited = await buildApp({
      dbPath: path.join(limitedDir, 'test.db'),
      logger: false,
      staticRoot: path.join(limitedDir, 'static'),
      userMapMaxPerUser: 1,
    });
    try {
      const reg = await limited.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: 'carl', password: 'password123' },
      });
      expect(reg.statusCode).toBe(200);
      const login = await limited.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'carl', password: 'password123' },
      });
      const token = login.json().data.token as string;
      const first = await limited.inject({
        method: 'POST',
        url: '/api/user-maps',
        headers: auth(token),
        payload: { map: mapOf('A') },
      });
      expect(first.statusCode).toBe(200);
      const second = await limited.inject({
        method: 'POST',
        url: '/api/user-maps',
        headers: auth(token),
        payload: { map: mapOf('B') },
      });
      expect(second.statusCode).toBe(409);
      expect(second.json().code).toBe('USER_MAP_LIMIT');
    } finally {
      await limited.close();
      rmSync(limitedDir, { recursive: true, force: true });
    }
  });
});

describe('社区地图与点赞', () => {
  it('未发布不可见；发布后可按标题/tag/作者搜索并读取完整地图', async () => {
    const alice = await registerAndLogin('alice');
    const created = await app.inject({
      method: 'POST',
      url: '/api/user-maps',
      headers: auth(alice),
      payload: { map: mapOf('社区图') },
    });
    const id = created.json().data.id as string;

    expect((await app.inject({ method: 'GET', url: '/api/community/maps' })).json().data.total).toBe(0);

    const published = await app.inject({
      method: 'POST',
      url: `/api/user-maps/${id}/publish`,
      headers: auth(alice),
    });
    expect(published.statusCode).toBe(200);
    expect(published.json().data.published).toBe(true);

    const list = await app.inject({
      method: 'GET',
      url: `/api/community/maps?search=${encodeURIComponent('社区')}`,
    });
    expect(list.json().data.total).toBe(1);
    const map = await app.inject({ method: 'GET', url: `/api/community/maps/${id}` });
    expect(map.statusCode).toBe(200);
    expect(map.json().data.id).toBe(id);
    const preview = await app.inject({ method: 'GET', url: `/api/community/maps/${id}/preview` });
    expect(preview.json().data.battlefield).toHaveLength(4);
  });

  it('已发布社区地图可作为多人房地图来源', async () => {
    const alice = await registerAndLogin('alice');
    const created = await app.inject({
      method: 'POST',
      url: '/api/user-maps',
      headers: auth(alice),
      payload: { map: mapOf('社区房图') },
    });
    const id = created.json().data.id as string;
    await app.inject({ method: 'POST', url: `/api/user-maps/${id}/publish`, headers: auth(alice) });

    const room = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: auth(alice),
      payload: {
        name: '社区图房间',
        allowSpectate: true,
        fogMode: false,
        randomSpawn: false,
        mapId: id,
        mapSource: 'community',
        timeSettings: { stepTime: 90, gameTime: 1200, additionalTime: 0 },
      },
    });
    expect(room.statusCode).toBe(200);
    expect(room.json().data.room.mapSource).toBe('community');
    expect(room.json().data.room.mapId).toBe(id);
  });

  it('点赞每个用户只能 +1，最受欢迎排序生效', async () => {
    const alice = await registerAndLogin('alice');
    const bob = await registerAndLogin('bob');
    const one = (await app.inject({
      method: 'POST',
      url: '/api/user-maps',
      headers: auth(alice),
      payload: { map: mapOf('热门') },
    })).json().data.id as string;
    const two = (await app.inject({
      method: 'POST',
      url: '/api/user-maps',
      headers: auth(alice),
      payload: { map: mapOf('冷门') },
    })).json().data.id as string;
    for (const id of [one, two]) {
      await app.inject({ method: 'POST', url: `/api/user-maps/${id}/publish`, headers: auth(alice) });
    }

    const first = await app.inject({
      method: 'POST',
      url: `/api/community/maps/${one}/like`,
      headers: auth(bob),
    });
    expect(first.json().data.likes).toBe(1);
    const again = await app.inject({
      method: 'POST',
      url: `/api/community/maps/${one}/like`,
      headers: auth(bob),
    });
    expect(again.json().data.likes).toBe(1);
    expect(again.json().data.liked).toBe(true);

    const second = await app.inject({
      method: 'POST',
      url: `/api/community/maps/${one}/like`,
      headers: auth(alice),
    });
    expect(second.json().data.likes).toBe(2);

    const popular = await app.inject({ method: 'GET', url: '/api/community/maps?sort=popular' });
    expect(popular.json().data.mapList[0].id).toBe(one);
    expect(popular.json().data.mapList[0].likes).toBe(2);
  });
});
