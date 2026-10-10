// AI 子进程生命周期（《AI参与对局机制修改方案》§5.4）：
// 每局含 AI 席位的对局 spawn 一个 ai-bot 子进程；对局结束（VICTORY/中止）、房间解散、服务器关闭时 kill；
// 崩溃（非主动 kill）按指数退避重拉，超出上限放弃。
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Game } from '../game/manager.js';
import type { BotSessionService } from '../ws/botSession.js';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export interface AiBotManagerOptions {
  enabled?: boolean;
  /** bot 入口 ts 文件（默认本目录 bot.ts） */
  entry?: string;
  /** boot 文件目录（默认 backend/data/bot_boot） */
  bootDir?: string;
  restartBackoffMs?: number;
  restartMax?: number;
  /** 难度2（普通）训练 MCTS AI 权重文件路径（缺省 config.aiWeightsPath；测试可注入以断言权重加载） */
  weightsPath?: string;
  /** 进程 stdout/stderr 输出回调（测试可注入） */
  onOutput?: (gameId: string, line: string) => void;
  /** 子进程 spawn 注入（单元测试 mock 用；缺省真实 spawn） */
  spawnFn?: typeof spawn;
}

interface BotRecord {
  /** 对局引用（status 实时更新：markFinished/markAborted 后不再重拉） */
  game: Game;
  /** 运行中的子进程；null 表示退避等待重拉中 */
  proc: ChildProcess | null;
  bootPath: string;
  restarts: number;
  killed: boolean;
  timer?: NodeJS.Timeout;
}

export class AiBotManager {
  private readonly bots = new Map<string, BotRecord>();
  private readonly enabled: boolean;
  private readonly entry: string;
  private readonly bootDir: string;
  private readonly restartBackoffMs: number;
  private readonly restartMax: number;
  private readonly weightsPath: string;
  private readonly tsxCli: string;
  private readonly onOutput?: (gameId: string, line: string) => void;
  private readonly spawnFn: typeof spawn;

  constructor(
    private readonly botSessions: BotSessionService,
    opts: AiBotManagerOptions = {},
  ) {
    this.enabled = opts.enabled ?? config.aiBotEnabled;
    this.entry = opts.entry ?? path.join(__dirname, 'bot.ts');
    this.bootDir = opts.bootDir ?? path.join(__dirname, '../../data/bot_boot');
    this.restartBackoffMs = opts.restartBackoffMs ?? config.aiBotRestartBackoffMs;
    this.restartMax = opts.restartMax ?? config.aiBotRestartMax;
    this.weightsPath = opts.weightsPath ?? config.aiWeightsPath;
    this.onOutput = opts.onOutput;
    this.spawnFn = opts.spawnFn ?? spawn;
    this.tsxCli = require.resolve('tsx/cli');
    mkdirSync(this.bootDir, { recursive: true });
  }

  get size(): number {
    return this.bots.size;
  }

  /** 对局创建后调用：仅当存在 AI 席位时 spawn（幂等：同一对局只拉一次） */
  spawn(game: Game, wsPort = config.port): void {
    if (!this.enabled) return;
    if (!game.seatAssignments.some((a) => a.isAI)) return;
    if (this.bots.has(game.id)) return;
    const token = this.botSessions.issue(game.id, game.roomId);
    const bootPath = path.join(this.bootDir, `${game.id}.json`);
    const wsUrl =
      `ws://127.0.0.1:${wsPort}/ws-bot` +
      `?token=${encodeURIComponent(token)}` +
      `&roomId=${encodeURIComponent(game.roomId)}` +
      `&gameId=${encodeURIComponent(game.id)}` +
      `&reducerVersion=${encodeURIComponent(game.reducerVersion)}`;
    writeFileSync(
      bootPath,
      JSON.stringify(
        {
          gameId: game.id,
          roomId: game.roomId,
          logFile: game.logFile,
          wsUrl,
          reducerVersion: game.reducerVersion,
          // 难度2 训练 MCTS AI 权重（格式异常/缺省时 bot 回退种子权重，不影响其他难度）
          weightsPath: this.weightsPath || undefined,
        },
        null,
        2,
      ),
      'utf8',
    );
    this.bots.set(game.id, { game, proc: null, bootPath, restarts: 0, killed: false });
    this.startProc(game.id);
  }

  /** 对局结束/房间解散/服务器关闭：终止并清理（幂等） */
  kill(gameId: string): void {
    const rec = this.bots.get(gameId);
    if (!rec) {
      this.cleanupBoot(gameId);
      return;
    }
    rec.killed = true;
    if (rec.timer) clearTimeout(rec.timer);
    this.bots.delete(gameId);
    this.cleanupBoot(gameId);
    if (rec.proc && rec.proc.exitCode === null) {
      rec.proc.kill('SIGTERM');
      const force = setTimeout(() => {
        if (rec.proc && rec.proc.exitCode === null) rec.proc.kill('SIGKILL');
      }, 3000);
      force.unref();
    }
  }

  /** 服务器关闭：全量终止 */
  dispose(): void {
    for (const gameId of [...this.bots.keys()]) this.kill(gameId);
  }

  // ---------- 内部 ----------

  private startProc(gameId: string): void {
    const rec = this.bots.get(gameId);
    if (!rec || rec.killed || rec.proc) return;
    const proc = this.spawnFn(process.execPath, [this.tsxCli, this.entry], {
      cwd: path.join(__dirname, '../..'),
      env: { ...process.env, AI_BOT_BOOT: rec.bootPath },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    rec.proc = proc;
    const pipe = (chunk: Buffer): void => {
      const line = String(chunk).trimEnd();
      if (line) this.onOutput?.(gameId, line);
    };
    proc.stdout?.on('data', pipe);
    proc.stderr?.on('data', pipe);
    proc.on('error', (err) => this.onOutput?.(gameId, `spawn 错误: ${err.message}`));
    proc.on('exit', (code, signal) => {
      this.onOutput?.(gameId, `bot 退出 code=${code} signal=${String(signal)}`);
      const cur = this.bots.get(gameId);
      if (!cur || cur.killed) return; // kill 路径已清理
      cur.proc = null; // 进程已退出：允许后续重拉
      // 对局已结束/中止：不再重拉（VICTORY/中止路径会先 kill，此处为竞态兜底）
      if (cur.game.status !== 'in_game') {
        this.onOutput?.(gameId, '对局已不在进行，放弃重拉');
        this.bots.delete(gameId);
        this.cleanupBoot(gameId);
        return;
      }
      if (cur.restarts >= this.restartMax) {
        this.onOutput?.(gameId, `重启次数超限（${this.restartMax}），放弃`);
        this.bots.delete(gameId);
        this.cleanupBoot(gameId);
        return;
      }
      const delay = this.restartBackoffMs * 2 ** cur.restarts;
      cur.restarts += 1;
      this.onOutput?.(gameId, `${delay}ms 后重拉`);
      cur.timer = setTimeout(() => this.startProc(gameId), delay);
      cur.timer.unref();
    });
  }

  private cleanupBoot(gameId: string): void {
    const bootPath = path.join(this.bootDir, `${gameId}.json`);
    if (existsSync(bootPath)) rmSync(bootPath, { force: true });
  }
}
