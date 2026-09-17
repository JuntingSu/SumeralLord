// 实时复现：3人对局中，一人被消灭（FORCE_CLEAR）后，下一条共识（投降→FORCE_CLEAR+VICTORY）是否被确认
// 依赖：dev 后端已运行在 127.0.0.1:4096
import WebSocket from 'ws';

const BASE = 'http://127.0.0.1:4096';
const WS_BASE = 'ws://127.0.0.1:4096';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
  });
  const json = await res.json();
  if (json.code && json.code !== 'OK') throw new Error(`${path} => ${JSON.stringify(json)}`);
  return json;
}

class Client {
  constructor(ws) {
    this.ws = ws;
    this.messages = [];
    this.waiters = [];
    ws.on('message', (d) => {
      const msg = JSON.parse(d.toString());
      this.messages.push(msg);
      this.waiters = this.waiters.filter((w) => {
        if (w.check(msg)) { w.resolve(msg); return false; }
        return true;
      });
    });
  }
  waitFor(match, timeoutMs = 6000) {
    const check = typeof match === 'string' ? (m) => m.type === match : match;
    const existing = this.messages.find(check);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`waitFor ${typeof match === 'string' ? match : '(fn)'} 超时, 已收: ${this.messages.map((m) => m.type).join(',')}`)), timeoutMs);
      this.waiters.push({ check, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  close() { try { this.ws.close(); } catch {} }
}

async function newUser(name) {
  try { await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: name, password: 'secret1' }) }); } catch {}
  const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: name, password: 'secret1' }) });
  return { token: login.data.token, id: login.data.user.id };
}
const auth = (u) => ({ authorization: `Bearer ${u.token}` });

async function wsConnect(roomId, user) {
  const res = await api('/api/ws-ticket', { headers: auth(user) });
  const ticket = res.data.ticket;
  const ws = new WebSocket(`${WS_BASE}/ws?ticket=${ticket}&roomId=${roomId}`);
  const c = new Client(ws);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await c.waitFor('CONNECT_ACK');
  return c;
}

const stamp = Date.now().toString(36);
const users = {};
for (const n of ['a', 'b', 'c']) users[n] = await newUser(`repro_${stamp}_${n}`);
console.log('users:', Object.fromEntries(Object.entries(users).map(([k, v]) => [k, v.id])));

// 创建房间（三足鼎立 3人图）
const room = await api('/api/rooms', {
  method: 'POST',
  headers: auth(users.a),
  body: JSON.stringify({
    name: `repro-${stamp}`,
    allowSpectate: false,
    fogMode: false,
    randomSpawn: false,
    mapId: 'map_trio_tripod',
    timeSettings: { stepTime: 300, gameTime: 3600, additionalTime: 0 },
  }),
});
const roomId = room.data.roomId;
console.log('room:', roomId);

// 加入并选势力
await api(`/api/rooms/${roomId}/join`, { method: 'POST', headers: auth(users.b), body: JSON.stringify({ asSpectator: false }) });
await api(`/api/rooms/${roomId}/join`, { method: 'POST', headers: auth(users.c), body: JSON.stringify({ asSpectator: false }) });
await api(`/api/rooms/${roomId}/select-force`, { method: 'POST', headers: auth(users.a), body: JSON.stringify({ seat: 1 }) });
await api(`/api/rooms/${roomId}/select-force`, { method: 'POST', headers: auth(users.b), body: JSON.stringify({ seat: 2 }) });
await api(`/api/rooms/${roomId}/select-force`, { method: 'POST', headers: auth(users.c), body: JSON.stringify({ seat: 3 }) });
await api(`/api/rooms/${roomId}/ready`, { method: 'POST', headers: auth(users.a), body: JSON.stringify({ ready: true }) });
await api(`/api/rooms/${roomId}/ready`, { method: 'POST', headers: auth(users.b), body: JSON.stringify({ ready: true }) });
await api(`/api/rooms/${roomId}/ready`, { method: 'POST', headers: auth(users.c), body: JSON.stringify({ ready: true }) });
await api(`/api/rooms/${roomId}/start`, { method: 'POST', headers: auth(users.a), body: JSON.stringify({}) });

// 连接 WS
const ca = await wsConnect(roomId, users.a);
const cb = await wsConnect(roomId, users.b);
const cc = await wsConnect(roomId, users.c);
console.log('WS connected');

const waitGameStart = async (c) => {
  const m = await c.waitFor('GAME_START');
  return m;
};
const [ga, gb, gc] = await Promise.all([waitGameStart(ca), waitGameStart(cb), waitGameStart(cc)]);
console.log('GAME_START ok, gameId:', ga.gameId);

// 座位对应：a=1, b=2, c=3
const clients = { 1: ca, 2: cb, 3: cc };

// 第一步：a(seat1) 投降 → FORCE_CLEAR(1)，游戏继续（2、3存活）
console.log('\n=== 步骤1: seat1 投降（FORCE_CLEAR(1)）===');
cb.send({ type: 'INTENT_SUBMIT', clientTempId: 'r1', intent: { intentType: 'SURRENDER', seat: 2, reason: 'voluntary' } });
// 等待所有端收到 CONSENSUS_CONFIRMED(force_clear:2)
try {
  const conf = await cb.waitFor((m) => m.type === 'CONSENSUS_CONFIRMED' && String(m.consensusId).includes('force_clear'), 6000);
  console.log('步骤1 确认:', JSON.stringify(conf.confirmed), 'eventId', conf.eventId);
} catch (e) {
  console.log('步骤1 失败:', e.message);
  console.log('seat2 收到的消息:', cb.messages.map((m) => m.type).join(','));
  process.exit(1);
}
await sleep(500);

// 第二步：b(seat2) 投降 → FORCE_CLEAR(2) + VICTORY
console.log('\n=== 步骤2: seat2 投降（FORCE_CLEAR(2) + VICTORY）===');
cc.send({ type: 'INTENT_SUBMIT', clientTempId: 'r2', intent: { intentType: 'SURRENDER', seat: 3, reason: 'voluntary' } });
try {
  const conf = await cc.waitFor((m) => m.type === 'CONSENSUS_CONFIRMED' && String(m.consensusId).includes('victory'), 6000);
  console.log('步骤2 VICTORY 确认:', JSON.stringify(conf.confirmed), 'eventId', conf.eventId);
} catch (e) {
  console.log('步骤2 失败:', e.message);
  console.log('seat3 收到的消息:', cc.messages.map((m) => m.type).join(','));
  process.exit(1);
}

console.log('\n全部共识确认成功。');
ca.close(); cb.close(); cc.close();
process.exit(0);
