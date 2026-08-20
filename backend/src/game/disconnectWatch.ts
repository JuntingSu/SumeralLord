// 断线治理时间线（后端方案 §3.5 / P3）：
// t=0 断开 → t=10s 推 PLAYER_DISCONNECT + 共识期望剔除 → t=120s 代发 SURRENDER(timeout)
// 宽限期内重连 → 取消全部计时器（重连广播由调用方负责）。
// 只做会话规则，不演算游戏逻辑；参数全部可配置（测试用加速值）。
export interface DisconnectHooks {
  /** t=detectMs：广播 PLAYER_DISCONNECT、该 seat 从共识期望集合剔除、参与者状态置断线 */
  onDisconnectDetected(gameId: string, seat: number): void;
  /** t=detectMs+graceMs：以 from:'SERVER' 注入 SURRENDER(timeout)（分配 eventId、持久化、广播） */
  onGraceExpired(gameId: string, seat: number): void;
}

interface WatchEntry {
  seat: number;
  detectTimer: NodeJS.Timeout;
  graceTimer: NodeJS.Timeout | null;
}

export class DisconnectWatch {
  private readonly pending = new Map<string, WatchEntry>();

  constructor(
    private readonly hooks: DisconnectHooks,
    private readonly detectMs: number,
    private readonly graceMs: number,
  ) {}

  /** 参战玩家失去全部连接（对局进行中） */
  disconnect(gameId: string, seat: number): void {
    const key = `${gameId}:${seat}`;
    if (this.pending.has(key)) return;
    const entry: WatchEntry = {
      seat,
      detectTimer: setTimeout(() => this.onDetect(gameId, entry), this.detectMs),
      graceTimer: null,
    };
    entry.detectTimer.unref();
    this.pending.set(key, entry);
  }

  /** 玩家重连成功（取消时间线） */
  reconnect(gameId: string, seat: number): void {
    const key = `${gameId}:${seat}`;
    const entry = this.pending.get(key);
    if (!entry) return;
    clearTimeout(entry.detectTimer);
    if (entry.graceTimer) clearTimeout(entry.graceTimer);
    this.pending.delete(key);
  }

  /** 对局结束/中止：清理该对局全部时间线（不再代发投降） */
  clearGame(gameId: string): void {
    for (const [key, entry] of this.pending) {
      if (!key.startsWith(`${gameId}:`)) continue;
      clearTimeout(entry.detectTimer);
      if (entry.graceTimer) clearTimeout(entry.graceTimer);
      this.pending.delete(key);
    }
  }

  dispose(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.detectTimer);
      if (entry.graceTimer) clearTimeout(entry.graceTimer);
    }
    this.pending.clear();
  }

  private onDetect(gameId: string, entry: WatchEntry): void {
    const key = `${gameId}:${entry.seat}`;
    if (!this.pending.has(key)) return;
    this.hooks.onDisconnectDetected(gameId, entry.seat);
    entry.graceTimer = setTimeout(() => this.onGrace(gameId, entry), this.graceMs);
    entry.graceTimer.unref();
  }

  private onGrace(gameId: string, entry: WatchEntry): void {
    this.pending.delete(`${gameId}:${entry.seat}`);
    this.hooks.onGraceExpired(gameId, entry.seat);
  }
}
