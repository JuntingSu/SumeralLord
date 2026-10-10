// 个人资料（PATCH /api/users/me）与皮肤上传（POST /api/users/me/skin）接口测试
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { inflateSync } from 'node:zlib';
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

/** 取出 PNG 全部 IDAT 数据（本仓库自产 PNG：8bit RGBA、filter=none，可逐字节解出像素） */
function readIdat(png: Buffer): Buffer {
  let off = 8;
  const parts: Buffer[] = [];
  while (off + 8 <= png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') parts.push(png.subarray(off + 8, off + 8 + len));
    if (type === 'IEND') break;
    off += 12 + len;
  }
  return Buffer.concat(parts);
}

/** 解出 (x,y) 处 RGBA 像素 */
function pngPixel(png: Buffer, x: number, y: number): [number, number, number, number] {
  const w = png.readUInt32BE(16);
  const raw = inflateSync(readIdat(png));
  const o = y * (w * 4 + 1) + 1 + x * 4;
  return [raw[o], raw[o + 1], raw[o + 2], raw[o + 3]];
}

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
    expect(body.data.user).toMatchObject({ username: 'alice', hasSkin: true });

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

  it('注册即生成默认皮肤；上传两张 192×216 PNG 覆盖成功，hasSkin 保持 true', async () => {
    const { token, userId } = await registerAndLogin('alice', 'secret1');

    // 注册即分配随机配色默认皮肤：文件已落盘、hasSkin 为 true
    const before = await app.inject({
      method: 'GET',
      url: '/api/users/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(before.json().data.user.hasSkin).toBe(true);
    expect(existsSync(skinFilePath(app.skinDir, userId))).toBe(true);
    expect(existsSync(skinFilePath(app.skinDir, userId, true))).toBe(true);
    const autoSolid = readFileSync(skinFilePath(app.skinDir, userId));
    expect([autoSolid.readUInt32BE(16), autoSolid.readUInt32BE(20)]).toEqual([192, 216]);

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
    // 上传内容覆盖了注册时的默认皮肤
    expect(readFileSync(skinFilePath(app.skinDir, userId)).equals(autoSolid)).toBe(false);

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

describe('注册默认皮肤', () => {
  it('注册后自动落盘一对 192×216 PNG，登录返回 hasSkin: true，颜色在 40–230 区间', async () => {
    const { token, userId } = await registerAndLogin('alice', 'secret1');

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password: 'secret1' },
    });
    expect(login.json().data.user.hasSkin).toBe(true);

    const solidPath = skinFilePath(app.skinDir, userId);
    const hollowPath = skinFilePath(app.skinDir, userId, true);
    expect(existsSync(solidPath)).toBe(true);
    expect(existsSync(hollowPath)).toBe(true);

    const solid = readFileSync(solidPath);
    const hollow = readFileSync(hollowPath);
    expect([solid.readUInt32BE(16), solid.readUInt32BE(20)]).toEqual([192, 216]);
    expect([hollow.readUInt32BE(16), hollow.readUInt32BE(20)]).toEqual([192, 216]);

    // 六边形中心为纯色填充（非描边），三通道均在 [40, 230] 且不透明
    const [r, g, b, a] = pngPixel(solid, 96, 108);
    expect(a).toBe(255);
    for (const c of [r, g, b]) {
      expect(c).toBeGreaterThanOrEqual(40);
      expect(c).toBeLessThanOrEqual(230);
    }
    // 断兵 hollow 版中心实心、外圈镂空：以顶部顶点附近（y 极靠上）为透明
    expect(pngPixel(hollow, 96, 108)[3]).toBe(255);
    expect(pngPixel(hollow, 96, 12)[3]).toBe(0);

    // 头像 URL 走皮肤（hasSkin 为 true）
    const me = await app.inject({ method: 'GET', url: '/api/users/me', headers: { authorization: `Bearer ${token}` } });
    expect(me.json().data.user.hasSkin).toBe(true);
  });
});

describe('POST /api/users/me/skin/random', () => {
  it('未携带 token 返回 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/users/me/skin/random' });
    expect(res.statusCode).toBe(401);
  });

  it('生成随机配色皮肤：返回色值与落盘像素一致，二次调用覆盖文件', async () => {
    const { token, userId } = await registerAndLogin('alice', 'secret1');

    const res = await app.inject({
      method: 'POST',
      url: '/api/users/me/skin/random',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const { hasSkin, color } = res.json().data as { hasSkin: boolean; color: string };
    expect(hasSkin).toBe(true);
    expect(color).toMatch(/^#[0-9a-f]{6}$/);

    const solidPath = skinFilePath(app.skinDir, userId);
    const first = readFileSync(solidPath);
    const [r, g, b, a] = pngPixel(first, 96, 108);
    expect(a).toBe(255);
    expect(color).toBe(`#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`);
    expect(existsSync(skinFilePath(app.skinDir, userId, true))).toBe(true);

    const again = await app.inject({
      method: 'POST',
      url: '/api/users/me/skin/random',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(again.statusCode).toBe(200);
    expect((again.json().data as { color: string }).color).toMatch(/^#[0-9a-f]{6}$/);
    expect([...readFileSync(solidPath).subarray(0, 8)]).toEqual([...first.subarray(0, 8)]);
  });
});
