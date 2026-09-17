// AI 决策托管子进程（《AI参与对局机制修改方案》§5.3）：
// - 读对局日志（GAME_START 首行 + INTENT_BROADCAST 事件流）全量重放，重建权威状态；
// - 订阅 /ws-bot 实时流；轮到 AI 席位时以 planAiTurn 生成意图，经 AI_INTENT_SUBMIT 逐条提交；
// - 重启 = 全量重放（不记忆跨重启计划）→ 提交天然幂等；WS 断开即退出，由 AiBotManager 看门狗重拉；
// - 服务器只中继不演算；本进程与各端前端以同一确定性 reducer 应用意图，逐条 ACK 推进。
// boot 路径经环境变量 AI_BOT_BOOT 传入（spawn 时避免 argv 索引歧义）。
import { openSync, readFileSync, readSync, statSync, closeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { applyIntent, initState, planAiTurn } from '@dl/shared';
import type { GameState, GameStartMsg, PlayerIntent, RoomServerMsg, SeatAssignment } from '@dl/shared';

export interface BotBoot {
  gameId: string;
  roomId: string;
  /** 对局日志绝对路径（GAME_START 首行 + 事件流追加写） */
  logFile: string;
  wsUrl: string;
  reducerVersion: string;
}

/** 追加写日志的增量读取器：只读新增完整行，容忍尾部半行（服务器写入中） */
class LogTailReader {
  private readonly fd: number;
  private pos = 0;

  constructor(private readonly file: string) {
    this.fd = openSync(file, 'r');
  }

  /** 返回本次新增的完整行（无新增返回空数组） */
  readLines(): string[] {
    const size = statSync(this.file).size;
    if (size <= this.pos) return [];
    const buf = Buffer.alloc(size - this.pos);
    readSync(this.fd, buf, 0, buf.length, this.pos);
    const text = buf.toString('utf8');
    if (!text.endsWith('\n')) {
      const lastNl = text.lastIndexOf('\n');
      if (lastNl === -1) return []; // 整段都是半行（首行写入中）：等下次
      const complete = text.slice(0, lastNl);
      this.pos += Buffer.byteLength(complete, 'utf8') + 1;
      return complete.split('\n');
    }
    this.pos = size;
    return text.split('\n').filter((l) => l.length > 0);
  }

  dispose(): void {
    closeSync(this.fd);
  }
}

/** skip 计划展开：休闲语义 = 连续切换阶段至回合结束（与旧 reducer 跳过循环等价） */
function skipIntents(board: GameState, seat: number): PlayerIntent[] {
  if (board.currentSeat === seat && board.phase === 'ACTION') {
    return [{ intentType: 'SWITCH_PHASE' }, { intentType: 'SWITCH_PHASE' }];
  }
  return [{ intentType: 'SWITCH_PHASE' }];
}

export class AiBot {
  private ws: WebSocket | null = null;
  private board: GameState | null = null;
  private seatAssignments: SeatAssignment[] = [];
  private appliedEventId = 0;
  private inflight: { clientTempId: string; seat: number; intent: PlayerIntent } | null = null;
  private tempSeq = 0;
  private finished = false;
  private readonly exited: Promise<void>;
  private resolveExit!: () => void;

  constructor(
    private readonly boot: BotBoot,
    private readonly out: (line: string) => void = console.log,
  ) {
    this.exited = new Promise((r) => (this.resolveExit = r));
  }

  log(line: string): void {
    this.out(`[ai-bot ${this.boot.gameId}] ${line}`);
  }

  /** 启动：日志重放 → WS 连接 → 首次驱动；直至退出条件（GAME_OVER / 连接断开） */
  async run(): Promise<void> {
    this.replayFromLog();
    if (this.finished) {
      this.log('对局已结束（日志含 GAME_OVER），退出');
      this.resolveExit();
    } else {
      await this.connect();
      this.drive();
    }
    await this.exited;
  }

  // ---------- 状态重建（日志 = 真相） ----------

  /** 全量重放（重启/补拉共用）：从 GAME_START 重建，按 eventId 应用全部已记录意图 */
  private replayFromLog(): void {
    const reader = new LogTailReader(this.boot.logFile);
    const lines = reader.readLines();
    reader.dispose();
    this.board = null;
    this.appliedEventId = 0;
    for (const line of lines) this.consumeLogLine(line);
  }

  private consumeLogLine(line: string): void {
    if (this.board === null) {
      const start = JSON.parse(line) as GameStartMsg;
      this.seatAssignments = start.seatAssignments;
      this.board = initState({
        map: start.map,
        seatAssignments: start.seatAssignments,
        timeSettings: start.timeSettings,
        seed: start.seed,
      }).state;
      return;
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // 非 JSON 行忽略
    }
    if (msg.type === 'GAME_OVER') {
      this.finished = true;
      return;
    }
    if (msg.type !== 'INTENT_BROADCAST') return;
    const eventId = msg.eventId as number;
    const intent = msg.intent as PlayerIntent;
    if (typeof eventId !== 'number' || !intent) return;
    this.apply(eventId, intent, (msg.fromSeat as number) ?? 0);
  }

  /** 应用意图（严格 eventId 序；拒绝/重复仅进游标，与各端 reducer 语义一致） */
  private apply(eventId: number, intent: PlayerIntent, fromSeat: number): void {
    if (this.board === null || this.finished) return;
    if (eventId <= this.appliedEventId) return;
    if (eventId !== this.appliedEventId + 1) {
      // 缺口（理论上仅日志竞态可达）：重放日志补齐
      this.log(`eventId 缺口：期望 ${this.appliedEventId + 1}，收到 ${eventId}，触发重放`);
      this.replayFromLog();
      return;
    }
    const r = applyIntent(this.board, { actor: { kind: 'PLAYER', seat: fromSeat }, intent });
    this.appliedEventId = eventId;
    if (r.ok) this.board = r.state;
    else this.log(`意图被拒绝（${r.reason}）：${JSON.stringify(intent)}`);
  }

  // ---------- WS 实时流 ----------

  private connect(): Promise<void> {
    return new Promise((resolve) => {
      const ws = new WebSocket(this.boot.wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => {
        this.log('ws 连接超时，退出');
        resolve();
        this.resolveExit();
      }, 10_000);
      timer.unref();
      ws.on('open', () => {
        clearTimeout(timer);
        this.log('ws 已连接');
        resolve();
      });
      ws.on('error', (err) => this.log(`ws 错误: ${err.message}`));
      ws.on('message', (data) => this.onMessage(String(data)));
      ws.on('close', (code, reason) => {
        clearTimeout(timer);
        this.log(`ws 关闭 code=${code} reason=${String(reason)}`);
        // 连接断开即退出：由 AiBotManager 看门狗按对局状态决定是否重拉
        resolve();
        this.resolveExit();
      });
    });
  }

  private onMessage(raw: string): void {
    let msg: RoomServerMsg & Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as RoomServerMsg & Record<string, unknown>;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'CONNECT_ACK':
        // 本地已按日志重放；服务器 lastEventId 仅作参考（日志为准）
        this.drive();
        break;
      case 'INTENT_ACK': {
        const inflight = this.inflight;
        if (!inflight || msg.clientTempId !== inflight.clientTempId) return;
        this.inflight = null;
        this.apply(msg.eventId as number, inflight.intent, inflight.seat);
        this.drive();
        break;
      }
      case 'INTENT_BROADCAST': {
        const eventId = msg.eventId as number;
        const intent = msg.intent as PlayerIntent;
        if (typeof eventId !== 'number' || !intent) return;
        this.apply(eventId, intent, (msg.fromSeat as number) ?? 0);
        this.drive();
        break;
      }
      case 'GAME_OVER':
        this.finished = true;
        this.log('收到 GAME_OVER，退出');
        this.resolveExit();
        break;
      case 'ERROR':
        // 服务器拒绝（如非法意图）：解除在途提交，重放后继续（拒绝不留死锁）
        this.log(`收到 ERROR: ${String(msg.code)} ${String(msg.message)}`);
        this.inflight = null;
        this.replayFromLog();
        this.drive();
        break;
      default:
        break; // CONSENSUS_CONFIRMED / TIME_SYNC 等不影响对局状态
    }
  }

  // ---------- AI 驱动 ----------

  /** 驱动检查：轮到 AI 席位且无在途提交时，规划并提交首条意图（逐条 ACK 推进） */
  private drive(): void {
    if (this.board === null || this.finished || this.inflight !== null) return;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const seat = this.board.currentSeat;
    const isAiSeat = this.seatAssignments.some((a) => a.seat === seat && a.isAI);
    if (!isAiSeat) return;
    if (this.board.phase !== 'ACTION' && this.board.phase !== 'ADD_POINT') return;
    // 每次驱动重新规划（确定性：同 seed 同状态 → 同决策），不记忆计划 → 重启幂等
    const plan = planAiTurn(this.board, seat);
    const intents = plan.kind === 'intents' ? plan.intents : skipIntents(this.board, seat);
    if (intents.length === 0) return;
    const intent = intents[0];
    const clientTempId = `bot-${++this.tempSeq}`;
    this.inflight = { clientTempId, seat, intent };
    ws.send(JSON.stringify({ type: 'AI_INTENT_SUBMIT', clientTempId, aiSeat: seat, intent }));
  }
}

async function main(): Promise<void> {
  const bootPath = process.env.AI_BOT_BOOT;
  if (!bootPath) {
    console.error('缺少 AI_BOT_BOOT 环境变量（bot 入口须由 AiBotManager spawn）');
    process.exit(2);
  }
  const boot = JSON.parse(readFileSync(bootPath, 'utf8')) as BotBoot;
  const bot = new AiBot(boot);
  process.on('SIGTERM', () => {
    bot.log('收到 SIGTERM，退出');
    process.exit(0);
  });
  process.on('SIGINT', () => process.exit(0));
  await bot.run();
  process.exit(0);
}

// 直接执行（node/tsx bot.ts）或经 AiBotManager spawn：入口统一
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main();
}
