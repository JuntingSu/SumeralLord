import type { RoomServerMsg } from '@dl/shared';

export type WsStatus = 'connecting' | 'open' | 'closed';

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000];
const PING_INTERVAL_MS = 30_000;

/**
 * 房间阶段 WS 客户端：一次性 ticket 握手、30s 心跳、指数退避重连。
 * 4001/4002/4007 等业务性拒绝不重连（ticket 失效/房间不存在/非成员）。
 */
export class WsClient {
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
    if (!body.success || !body.data) {
      this.emitStatus('closed');
      throw new Error(body.message ?? '获取连接票据失败');
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?ticket=${body.data.ticket}&roomId=${this.roomId}`);
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
