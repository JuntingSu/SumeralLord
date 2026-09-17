import type { ConsensusPayload, PlayerIntent, RoomServerMsg } from '@dl/shared';
import { reducerVersion } from '@dl/shared';
import type { GameTransport } from '../stores/game';

export type WsStatus = 'connecting' | 'open' | 'closed';

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000];
const PING_INTERVAL_MS = 30_000;

/**
 * 房间阶段 WS 客户端：一次性 ticket 握手、30s 心跳、指数退避重连。
 * 对局阶段（M4）：实现 GameTransport——意图提交 / 共识上报 / TIME_SYNC / RECONNECT / 补发拉取。
 * 4001/4002/4007 等业务性拒绝不重连；4003（版本不一致）不重连。
 */
export class WsClient implements GameTransport {
  private ws: WebSocket | null = null;
  private pingTimer: number | null = null;
  private reconnectAttempt = 0;
  private closedByUser = false;
  private readonly messageHandlers = new Set<(msg: RoomServerMsg) => void>();
  private readonly statusHandlers = new Set<(status: WsStatus) => void>();

  constructor(private readonly roomId: string) {}

  onMessage(handler: (msg: RoomServerMsg) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStatus(handler: (status: WsStatus) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  async connect(): Promise<void> {
    this.closedByUser = false;
    await this.connectOnce();
  }

  private async connectOnce(): Promise<void> {
    this.emitStatus('connecting');
    const token = localStorage.getItem('dl_token') ?? '';
    const res = await fetch('/api/ws-ticket', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const body = (await res.json()) as { success: boolean; data?: { ticket: string }; message?: string };
    // close() 已调用（组件卸载/顶替）：不再建立连接，避免迟到连接顶替新连接
    if (this.closedByUser) return;
    if (!body.success || !body.data) {
      this.emitStatus('closed');
      throw new Error(body.message ?? '获取连接票据失败');
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(
      `${proto}://${location.host}/ws?ticket=${body.data.ticket}&roomId=${this.roomId}&reducerVersion=${encodeURIComponent(reducerVersion())}`,
    );
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.emitStatus('open');
      this.pingTimer = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'PING' }));
      }, PING_INTERVAL_MS);
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as RoomServerMsg;
        for (const h of this.messageHandlers) h(msg);
      } catch {
        // 非 JSON 消息忽略
      }
    };

    ws.onclose = (ev) => {
      if (this.pingTimer !== null) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      this.emitStatus('closed');
      if (this.closedByUser) return;
      // 业务性拒绝不重连（4006 顶替除外，顶替说明本端状态过期，重连可恢复）
      if (ev.code >= 4000 && ev.code !== 4006) return;
      if (this.reconnectAttempt >= RECONNECT_DELAYS.length) return;
      const delay = RECONNECT_DELAYS[this.reconnectAttempt];
      this.reconnectAttempt += 1;
      window.setTimeout(() => {
        this.connectOnce().catch(() => undefined);
      }, delay);
    };
  }

  sendChat(text: string): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ type: 'CHAT', text }));
    return true;
  }

  // ---------- 对局阶段（GameTransport） ----------

  submitIntent(clientTempId: string, intent: PlayerIntent): void {
    this.sendJson({ type: 'INTENT_SUBMIT', clientTempId, intent });
  }

  submitConsensus(consensusId: string, result: ConsensusPayload): void {
    this.sendJson({ type: 'CONSENSUS_RESULT', consensusId, result });
  }

  sendTimeSync(gameId: string, seat: number, stepTimeRemain: number, gameTimeRemain: number): void {
    this.sendJson({ type: 'TIME_SYNC', gameId, seat, stepTimeRemain, gameTimeRemain, ts: Date.now() });
  }

  sendReconnect(lastEventId: number, gameId: string): void {
    this.sendJson({ type: 'RECONNECT', lastEventId, gameId });
  }

  sendSettlementDismissed(gameId: string): void {
    this.sendJson({ type: 'SETTLEMENT_DISMISSED', gameId });
  }

  async fetchEvents(
    gameId: string,
    after: number,
    limit = 500,
  ): Promise<{ events: Array<Record<string, unknown>>; nextCursor: number }> {
    const token = localStorage.getItem('dl_token') ?? '';
    const res = await fetch(`/api/game/${gameId}/events?after=${after}&limit=${limit}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const body = (await res.json()) as { success: boolean; data?: { events: Array<Record<string, unknown>>; nextCursor: number } };
    if (!body.success || !body.data) throw new Error('补发拉取失败');
    return body.data;
  }

  private sendJson(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.closedByUser = true;
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  private emitStatus(status: WsStatus): void {
    for (const h of this.statusHandlers) h(status);
  }
}
