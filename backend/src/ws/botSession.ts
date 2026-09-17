// AI bot 会话服务：为 ai-bot 子进程签发一次性 /ws-bot 握手凭证（与玩家 ticket 隔离）。
// token 绑定 (gameId, roomId)，核销即焚；对局结束/房间解散时由 AiBotManager 显式 revokeByGame。
import { randomUUID } from 'node:crypto';

export interface BotSession {
  gameId: string;
  roomId: string;
  expiresAt: number;
}

const BOT_TOKEN_TTL_MS = 5 * 60 * 1000;

export class BotSessionService {
  private readonly sessions = new Map<string, BotSession>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly ttlMs: number = BOT_TOKEN_TTL_MS) {
    this.sweeper = setInterval(() => this.sweep(), 30_000);
    this.sweeper.unref();
  }

  /** 为对局签发一次性 bot token */
  issue(gameId: string, roomId: string): string {
    const token = randomUUID();
    this.sessions.set(token, { gameId, roomId, expiresAt: Date.now() + this.ttlMs });
    return token;
  }

  /** 核销（一次性，过期返回 null） */
  consume(token: string): BotSession | null {
    const session = this.sessions.get(token);
    if (!session) return null;
    this.sessions.delete(token);
    if (Date.now() > session.expiresAt) return null;
    return session;
  }

  /** 对局结束/房间解散：吊销该对局全部未使用 token */
  revokeByGame(gameId: string): void {
    for (const [token, s] of this.sessions) {
      if (s.gameId === gameId) this.sessions.delete(token);
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [token, s] of this.sessions) {
      if (now > s.expiresAt) this.sessions.delete(token);
    }
  }

  dispose(): void {
    clearInterval(this.sweeper);
    this.sessions.clear();
  }
}
