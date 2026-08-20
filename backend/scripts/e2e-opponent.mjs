// 联调脚本：自动行动的"脚本对手 B"（M5 GUI 目检用）。
// B 端也跑本地 reducer（@dl/shared applyIntent/initState，与 A 端同源）：
// 按 eventId 序应用全部意图 → 得知自己的回合/阶段 → 用 listAiActions 选第一个合法行动自动执行。
// 这同时实战验证了 AI 策略层的行动枚举接口。
// 用法：node scripts/e2e-opponent.mjs <roomId> [--attack-first]
import WebSocket from 'ws';
import { applyIntent, initState, listAiActions } from '@dl/shared';

const BASE = 'http://127.0.0.1:3000';
const roomId = process.argv[2];
const attackFirst = process.argv.includes('--attack-first');
if (!roomId) {
  console.error('用法: node scripts/e2e-opponent.mjs <roomId> [--attack-first]');
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await jf('POST', '/api/auth/register', { username: '玩家E2EB', password: 'test123456' });
const login = await jf('POST', '/api/auth/login', { username: '玩家E2EB', password: 'test123456' });
token = login.data.token;
log(`登录成功 userId=${login.data.user.id}`);

const join = await jf('POST', `/api/rooms/${roomId}/join`, { asSpectator: false });
if (!join.success) {
  log(`加入失败: ${join.code} ${join.message}`);
  process.exit(2);
}
log(`已加入房间（玩家 ${join.data.room.players.length} 人）`);

const ticketRes = await jf('GET', '/api/ws-ticket');
const ws = new WebSocket(`ws://127.0.0.1:3000/ws?ticket=${ticketRes.data.ticket}&roomId=${roomId}`);

const MY_SEAT = 2;
let board = null; // B 端权威 boardState（与 A 端同源 reducer）
let appliedEventId = 0;
let pendingIntent = null; // clientTempId → intent（ACK 时应用）

function applyStream(eventId, intent, fromSeat) {
  if (!board) return;
  if (eventId <= appliedEventId) return;
  if (eventId !== appliedEventId + 1) {
    log(`EVENT_GAP at ${eventId}（applied=${appliedEventId}）——跳过，等补发逻辑简化为直接追`);
    return;
  }
  const r = applyIntent(board, { actor: { kind: fromSeat === MY_SEAT ? 'PLAYER' : 'PLAYER', seat: fromSeat }, intent });
  appliedEventId = eventId;
  if (!r.ok) {
    log(`意图被确定性拒绝: ${r.reason}`);
    return;
  }
  board = r.state;
  reportConsensus(eventId, r.chain);
  maybeAct();
}

function sendIntent(intent, tag) {
  const clientTempId = `b${Date.now()}-${tag}`;
  pendingIntent = { clientTempId, intent };
  ws.send(JSON.stringify({ type: 'INTENT_SUBMIT', clientTempId, intent }));
}

/** 从事件链提取共识节点并按服务器格式上报（与前端 game/consensus.ts 同构，避免 CONSENSUS_TIMEOUT） */
function reportConsensus(triggerEventId, chain) {
  for (const ev of chain) {
    if (ev.kind === 'FORCE_CLEAR') {
      ws.send(JSON.stringify({
        type: 'CONSENSUS_RESULT',
        fromSeat: MY_SEAT,
        consensusId: `${triggerEventId}:force_clear:${ev.seat}`,
        result: { kind: 'FORCE_CLEAR', seat: ev.seat, reason: ev.reason },
      }));
      log(`共识上报: ${triggerEventId}:force_clear:${ev.seat}`);
    } else if (ev.kind === 'VICTORY') {
      ws.send(JSON.stringify({
        type: 'CONSENSUS_RESULT',
        fromSeat: MY_SEAT,
        consensusId: `${triggerEventId}:victory:0`,
        result: { kind: 'VICTORY', winningTeam: ev.winningTeam, winners: ev.winners, losers: ev.losers },
      }));
      log(`共识上报: ${triggerEventId}:victory:0`);
    }
  }
}

/** 轮到自己且行动阶段/加点阶段：自动行动（无条件推进回合：行动或直切阶段） */
function maybeAct() {
  if (!board || board.finished) return;
  if (board.currentSeat !== MY_SEAT) return;
  if (board.phase === 'ACTION') {
    const actions = listAiActions(board, MY_SEAT);
    if (actions.length === 0) {
      log('无合法行动，直接切阶段');
      sendIntent({ intentType: 'SWITCH_PHASE' }, 's1');
      return;
    }
    const pick = attackFirst ? actions.find((a) => a.kind === 'ATTACK') ?? actions[0] : actions[0];
    log(`行动: ${pick.kind} from=${pick.from} to=${pick.to}`);
    sendIntent({ intentType: pick.kind, from: pick.from, to: pick.to }, 'a');
    return;
  }
  if (board.phase === 'ADD_POINT') {
    sendIntent({ intentType: 'SWITCH_PHASE' }, 's2');
  }
}

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'PONG') return;
  if (msg.type === 'GAME_START') {
    log('对局开始，初始化本地 reducer');
    board = initState({ map: msg.map, seatAssignments: msg.seatAssignments, timeSettings: msg.timeSettings }).state;
    return;
  }
  if (msg.type === 'INTENT_ACK') {
    if (pendingIntent && pendingIntent.clientTempId === msg.clientTempId) {
      applyStream(msg.eventId, pendingIntent.intent, MY_SEAT);
      pendingIntent = null;
    }
    return;
  }
  if (msg.type === 'INTENT_BROADCAST') {
    applyStream(msg.eventId, msg.intent, msg.fromSeat);
    return;
  }
  if (msg.type === 'CONSENSUS_CONFIRMED') {
    return; // B 不参与共识上报（娱乐目检场景）
  }
  if (msg.type === 'GAME_OVER') {
    log('对局结束');
    process.exit(0);
  }
  if (msg.type === 'ERROR' && msg.fatal) {
    log(`fatal: ${msg.code}`);
    process.exit(3);
  }
});

ws.on('close', (code) => {
  log(`WS 关闭 code=${code}`);
  process.exit(0);
});

// 心跳：服务器 60s 无消息判定断线，30s 主动 PING
setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'PING' }));
}, 30_000);

// 准备 + 选势力
setTimeout(async () => {
  await jf('POST', `/api/rooms/${roomId}/ready`, { ready: true });
  log('已准备');
  await jf('POST', `/api/rooms/${roomId}/select-force`, { seat: MY_SEAT });
  log(`已选择 seat ${MY_SEAT}`);
}, 500);

setTimeout(() => {
  log('150s 超时退出');
  process.exit(0);
}, 150_000);
