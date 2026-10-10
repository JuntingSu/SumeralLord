import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { TicketService } from '../src/auth/ticket.js';
import { signAuthToken } from '../src/auth/jwt.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let app: FastifyInstance;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'dl-test-'));
  app = await buildApp({ dbPath: path.join(dir, 'test.db'), logger: false, skinDir: path.join(dir, 'skin') });
});

afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/health', () => {
  it('返回统一包裹的健康状态', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { status: 'ok' } });
  });
});

describe('POST /api/auth/register', () => {
  it('合法输入注册成功，不自动登录', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'secret1' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.message).toBe('注册成功');
    expect(body.data).toBeUndefined();
  });

  it('用户名过短返回 400 INVALID_PARAMS', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'ab', password: 'secret1' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_PARAMS');
  });

  it('密码过短返回 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: '12345' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_PARAMS');
  });

  it('用户名包含空白字符返回 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'a b', password: 'secret1' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('重复用户名返回 409 USERNAME_TAKEN', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'secret1' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'secret2' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('USERNAME_TAKEN');
  });

  it('超过频率限制返回 429（5 次/分钟/IP）', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: `user${i}`, password: 'secret1' },
      });
      expect(res.statusCode).toBe(200);
    }
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'user6', password: 'secret1' },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().code).toBe('RATE_LIMITED');
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(async () => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'secret1' },
    });
  });

  it('登录成功返回 token 与用户信息', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password: 'secret1' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(typeof body.data.token).toBe('string');
    expect(body.data.user).toMatchObject({ username: 'alice', matches: 0, wins: 0, flag: 1 });
    expect(body.data.user.id).toBeGreaterThan(0);
  });

  it('密码错误返回 401 AUTH_FAILED', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password: 'wrong12' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('AUTH_FAILED');
  });

  it('用户不存在返回 401（不泄露存在性）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'nobody', password: 'whatever' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('AUTH_FAILED');
  });
});

describe('GET /api/ws-ticket', () => {
  it('未携带 Bearer 返回 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/ws-ticket' });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('AUTH_FAILED');
  });

  it('携带合法 JWT 返回 ticket，且 ticket 一次性有效', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'secret1' },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password: 'secret1' },
    });
    const token: string = login.json().data.token;

    const res = await app.inject({
      method: 'GET',
      url: '/api/ws-ticket',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const ticket: string = res.json().data.ticket;
    expect(ticket).toBeTruthy();

    expect(app.tickets.consume(ticket)).toMatchObject({ userId: expect.any(Number), username: 'alice' });
    expect(app.tickets.consume(ticket)).toBeNull();
  });

  it('伪造 JWT 返回 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/ws-ticket',
      headers: { authorization: 'Bearer fake.jwt.token' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('TicketService（单元）', () => {
  it('过期 ticket 核销返回 null', async () => {
    const service = new TicketService(30);
    const ticket = service.issue(1, 'alice');
    await sleep(50);
    expect(service.consume(ticket)).toBeNull();
    service.dispose();
  });

  it('不同 ticket 互不影响', () => {
    const service = new TicketService();
    const t1 = service.issue(1, 'alice');
    const t2 = service.issue(2, 'bob');
    service.consume(t1);
    expect(service.consume(t2)).toMatchObject({ username: 'bob' });
    service.dispose();
  });
});

describe('静态资源', () => {
  const flagsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'static', 'flags');

  it.skipIf(!existsSync(path.join(flagsDir, 'flag_1.png')))(
    'GET /static/flags/flag_1.png 返回 PNG',
    async () => {
      const res = await app.inject({ method: 'GET', url: '/static/flags/flag_1.png' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('image/png');
    },
  );
});

describe('JWT', () => {
  it('签发的 token 携带 userId/username 与 7 天有效期', () => {
    const token = signAuthToken({ userId: 42, username: 'alice' });
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    expect(payload.userId).toBe(42);
    expect(payload.username).toBe('alice');
    expect(payload.exp - payload.iat).toBe(7 * 24 * 60 * 60);
  });
});
