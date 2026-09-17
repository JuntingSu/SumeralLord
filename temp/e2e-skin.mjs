// 端到端验证：注册 → 登录 → 改用户名/密码 → 上传皮肤 → 创建带"使用个人皮肤"的房间 → 开局 → 校验 GAME_START 旗帜
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'http://127.0.0.1:4097';
const ROOT = path.dirname(fileURLToPath(import.meta.url)); // temp/
const REPO = path.join(ROOT, '..');

const U = (p, opts) =>
  fetch(BASE + p, opts).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

async function main() {
  const uname = 'skin_t' + (Date.now() % 100000);
  const pw = 'secret1';

  let r = await U('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: uname, password: pw }),
  });
  console.log('register:', r.status);

  r = await U('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: uname, password: pw }),
  });
  let token = r.body.data.token;
  const user = r.body.data.user;
  console.log('login user:', JSON.stringify(user));
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // 改用户名 → 返回重签 token
  r = await U('/api/users/me', { method: 'PATCH', headers: auth, body: JSON.stringify({ username: uname + 'x' }) });
  console.log('patch username:', r.status, '->', r.body.data.user.username, '| reissued token:', !!r.body.data.token);
  token = r.body.data.token || token;
  const auth2 = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // 改密码：原密码错误
  r = await U('/api/users/me', { method: 'PATCH', headers: auth2, body: JSON.stringify({ oldPassword: 'wrongpw', newPassword: 'secret2' }) });
  console.log('patch pw wrong old:', r.status, r.body.code, r.body.message);
  if (r.status !== 400 || r.body.code !== 'PASSWORD_WRONG') throw new Error('原密码错误未拦截');

  // 改密码：正确
  r = await U('/api/users/me', { method: 'PATCH', headers: auth2, body: JSON.stringify({ oldPassword: pw, newPassword: 'secret2' }) });
  console.log('patch pw ok:', r.status, '| token unchanged:', r.body.data.token === undefined);

  // 上传皮肤（用真实 flag_1 / flag_1_hollow 两张 192×216 PNG）
  const solid = 'data:image/png;base64,' + fs.readFileSync(path.join(REPO, 'backend/static/flags/flag_1.png')).toString('base64');
  const hollow = 'data:image/png;base64,' + fs.readFileSync(path.join(REPO, 'backend/static/flags/flag_1_hollow.png')).toString('base64');
  r = await U('/api/users/me/skin', { method: 'POST', headers: auth2, body: JSON.stringify({ solid, hollow }) });
  console.log('upload skin:', r.status, JSON.stringify(r.body.data));
  if (r.status !== 200) throw new Error('皮肤上传失败');

  const uid = user.id;
  const solidFile = path.join(REPO, `backend/static/skin/usr_${uid}.png`);
  const hollowFile = path.join(REPO, `backend/static/skin/usr_${uid}_hollow.png`);
  console.log('skin files on disk:', fs.existsSync(solidFile), fs.existsSync(hollowFile));

  // 静态访问 + me.hasSkin
  const served = await fetch(`${BASE}/static/skin/usr_${uid}.png`);
  console.log('GET /static/skin/usr_' + uid + '.png:', served.status, served.headers.get('content-type'));
  r = await U('/api/users/me', { method: 'GET', headers: auth2 });
  console.log('me.hasSkin:', r.body.data.user.hasSkin);

  // 选图 + 建房间（使用个人皮肤）
  r = await U('/api/maps', { headers: auth2 });
  const mapList = r.body.data.mapList;
  const mapId = mapList.find((m) => m.id === 'map_duo_plain')?.id ?? mapList[0].id;
  console.log('mapId:', mapId);

  r = await U('/api/rooms', {
    method: 'POST',
    headers: auth2,
    body: JSON.stringify({
      name: 'skin-room',
      allowSpectate: false,
      fogMode: false,
      randomSpawn: false,
      usePersonalSkin: true,
      mapId,
      timeSettings: { stepTime: 90, gameTime: 1200, additionalTime: 0 },
    }),
  });
  const room = r.body.data.room;
  console.log('create room:', r.status, '| room.usePersonalSkin:', room.usePersonalSkin);
  if (!room.usePersonalSkin) throw new Error('usePersonalSkin 未保存');

  const seat = room.forces[0].seat;
  r = await U(`/api/rooms/${room.id}/select-force`, { method: 'POST', headers: auth2, body: JSON.stringify({ seat }) });
  console.log('select-force:', r.status);
  r = await U(`/api/rooms/${room.id}/ready`, { method: 'POST', headers: auth2, body: JSON.stringify({ ready: true }) });
  console.log('ready:', r.status);
  r = await U(`/api/rooms/${room.id}/start`, { method: 'POST', headers: auth2, body: JSON.stringify({}) });
  console.log('start:', r.status, JSON.stringify(r.body.data));
  if (r.status !== 200) throw new Error('开局失败');

  // 读最新对局日志的 GAME_START 首行，校验势力旗帜
  const logDir = path.join(REPO, 'backend/data/game_logs');
  const logs = fs.readdirSync(logDir).filter((f) => f.endsWith('.jsonl')).map((f) => ({ f, t: fs.statSync(path.join(logDir, f)).mtimeMs }));
  logs.sort((a, b) => b.t - a.t);
  const start = JSON.parse(fs.readFileSync(path.join(logDir, logs[0].f), 'utf8').split('\n')[0]);
  const flags = start.map.player_list.map((p) => `seat${p.seat}:${p.flag}`);
  console.log('GAME_START flags:', flags.join(' '));
  const occupied = start.map.player_list.find((p) => p.seat === seat);
  console.log('expected host seat', seat, 'flag = -' + uid, '-> got', occupied.flag);
  if (occupied.flag !== -uid) throw new Error('开局未替换为个人皮肤旗帜');

  console.log('\n✅ 全部通过');
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
