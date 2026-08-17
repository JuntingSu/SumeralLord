// 合并测试脚本：模拟第二玩家 B（REST 加入 + WS 连接 + 准备/选势力/聊天，等待被踢）
// 用法：node scripts/e2e-player.mjs <roomId>
import WebSocket from 'ws';

const BASE = 'http://localhost:3000';
const roomId = process.argv[2];
if (!roomId) {
  console.error('用法: node scripts/e2e-player.mjs <roomId>');
  process.exit(1);
}

let token = '';
async function jf(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

const log = (msg) => console.log(`[B ${new Date().toISOString().slice(11, 19)}] ${msg}`);

// 注册（已存在则忽略）+ 登录
await jf('POST', '/api/auth/register', { username: '玩家E2EB', password: 'test123456' });
const login = await jf('POST', '/api/auth/login', { username: '玩家E2EB', password: 'test123456' });
token = login.data.token;
log(`登录成功 userId=${login.data.user.id}`);

// 加入房间
const join = await jf('POST', `/api/rooms/${roomId}/join`, { asSpectator: false });
if (!join.success) {
  log(`加入失败: ${join.code} ${join.message}`);
  process.exit(2);
}
log(`已加入房间（玩家 ${join.data.room.players.length} 人）`);

// WS 连接
const ticketRes = await jf('GET', '/api/ws-ticket');
const ws = new WebSocket(`ws://127.0.0.1:3000/ws?ticket=${ticketRes.data.ticket}&roomId=${roomId}`);
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'PONG') return;
  log(`收到推送: ${JSON.stringify(msg)}`);
  if (msg.type === 'PLAYER_LEAVE' && msg.playerId === login.data.user.id) {
    log('被移出房间，测试结束');
    setTimeout(() => process.exit(0), 300);
  }
});
ws.on('close', (code) => log(`WS 关闭 code=${code}`));

setTimeout(async () => {
  await jf('POST', `/api/rooms/${roomId}/ready`, { ready: true });
  log('已准备');
  await jf('POST', `/api/rooms/${roomId}/select-force`, { seat: 2 });
  log('已选择 seat 2');
  setTimeout(() => {
    ws.send(JSON.stringify({ type: 'CHAT', text: '大家好，我是B！' }));
    log('已发送聊天');
  }, 400);
}, 500);

// 90s 兜底退出
setTimeout(() => {
  log('超时退出');
  process.exit(0);
}, 90_000);
