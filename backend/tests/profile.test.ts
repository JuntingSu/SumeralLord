// 个人资料（PATCH /api/users/me）与皮肤上传（POST /api/users/me/skin）接口测试
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { skinFilePath } from '../src/skin.js';

let app: FastifyInstance;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'dl-test-'));
  // staticRoot 指向临时目录：皮肤文件写入临时 skin 目录，不污染仓库 backend/static/skin
  app = await buildApp({ dbPath: path.join(dir, 'test.db'), logger: false, staticRoot: path.join(dir, 'static') });
});

afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 注册 + 登录，返回 Bearer token 与 userId */
async function registerAndLogin(username: string, password: string): Promise<{ token: string; userId: number }> {
  await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  const data = login.json().data;
  return { token: data.token as string, userId: data.user.id as number };
}

/** 构造最小合法 PNG（签名 + IHDR 宽高），decodePngDataUrl 只校验这两处 */
function fakePng(w = 192, h = 216): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); // IHDR 长度
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(w, 8); // 绝对偏移 16 = width
  ihdr.writeUInt32BE(h, 12); // 绝对偏移 20 = height
  return Buffer.concat([sig, ihdr]);
}

const pngDataUrl = (buf: Buffer) => `data:image/png;base64,${buf.toString('base64')}`;

describe('PATCH /api/users/me', () => {
  it('未携带 token 返回 401', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/users/me',
      payload: { username: 'newname' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('AUTH_FAILED');
  });

  it('改密码需原密码正确：原密码错误返回 400 PASSWORD_WRONG', async () => {
    const { token } = await registerAndLogin('alice', 'secret1');
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/users/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { oldPassword: 'wrongpw', newPassword: 'newsecret' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('PASSWORD_WRONG');
  });

  it('改密码缺原密码返回 400 PASSWORD_WRONG', async () => {
    const { token } = await registerAndLogin('alice', 'secret1');
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/users/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { newPassword: 'newsecret' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('PASSWORD_WRONG');
  });

  it('改密码成功：新密码可登录、旧密码失效，不改用户名不返回 token', async () => {
    const { token } = await registerAndLogin('alice', 'secret1');
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/users/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { oldPassword: 'secret1', newPassword: 'newsecret' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.token).toBeUndefined();
    expect(body.data.user).toMatchObject({ username: 'alice', hasSkin: false });

    const oldLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password: 'secret1' },
    });
    expect(oldLogin.statusCode).toBe(401);

    const newLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password: 'newsecret' },
    });
    expect(newLogin.statusCode).toBe(200);
  });

  it('改用户名成功：返回新 user 与携带新用户名的 token', async () => {
    const { token } = await registerAndLogin('alice', 'secret1');
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/users/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { username: 'alice2' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.user.username).toBe('alice2');
    expect(typeof body.data.token).toBe('string');
    const payload = JSON.parse(Buffer.from(body.data.token.split('.')[1], 'base64url').toString('utf8'));
    expect(payload).toMatchObject({ userId: body.data.user.id, username: 'alice2' });
  });

  it('改用户名与他人重复返回 409 USERNAME_TAKEN', async () => {
    await registerAndLogin('bob', 'secret1');
    const { token } = await registerAndLogin('alice', 'secret1');
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/users/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { username: 'bob' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('USERNAME_TAKEN');
  });

  it('用户名含空白字符返回 400', async () => {
    const { token } = await registerAndLogin('alice', 'secret1');
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/users/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { username: 'a b' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_PARAMS');
  });

  it('未提供任何修改项返回 400', async () => {
    const { token } = await registerAndLogin('alice', 'secret1');
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/users/me',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_PARAMS');
  });
});

describe('POST /api/users/me/skin', () => {
  it('未携带 token 返回 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/users/me/skin',
      payload: { solid: pngDataUrl(fakePng()), hollow: pngDataUrl(fakePng()) },
    });
    expect(res.statusCode).toBe(401);
  });

  it('上传两张 192×216 PNG 成功，文件落盘，hasSkin 变为 true', async () => {
    const { token, userId } = await registerAndLogin('alice', 'secret1');

    const before = await app.inject({
      method: 'GET',
      url: '/api/users/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(before.json().data.user.hasSkin).toBe(false);

    const res = await app.inject({
      method: 'POST',
      url: '/api/users/me/skin',
      headers: { authorization: `Bearer ${token}` },
      payload: { solid: pngDataUrl(fakePng()), hollow: pngDataUrl(fakePng()) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ hasSkin: true });
    expect(existsSync(skinFilePath(app.skinDir, userId))).toBe(true);
    expect(existsSync(skinFilePath(app.skinDir, userId, true))).toBe(true);

    const after = await app.inject({
      method: 'GET',
      url: '/api/users/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.json().data.user.hasSkin).toBe(true);
  });

  it('非 PNG / 尺寸不符返回 400', async () => {
    const { token } = await registerAndLogin('alice', 'secret1');
    const res = await app.inject({
      method: 'POST',
      url: '/api/users/me/skin',
      headers: { authorization: `Bearer ${token}` },
      payload: { solid: pngDataUrl(fakePng(100, 100)), hollow: pngDataUrl(fakePng()) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_PARAMS');
  });

  it('非法 base64 返回 400', async () => {
    const { token } = await registerAndLogin('alice', 'secret1');
    const res = await app.inject({
      method: 'POST',
      url: '/api/users/me/skin',
      headers: { authorization: `Bearer ${token}` },
      payload: { solid: 'not-an-image', hollow: pngDataUrl(fakePng()) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_PARAMS');
  });
});
