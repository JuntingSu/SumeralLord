import { randomUUID } from 'node:crypto';
import { AUTH } from '@dl/shared';

export interface TicketInfo {
  userId: number;
  username: string;
  expiresAt: number;
}

/** 一次性 WS ticket：5 分钟有效，核销即焚（内存实现，随进程销毁） */
export class TicketService {
  private readonly tickets = new Map<string, TicketInfo>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly ttlMs: number = AUTH.TICKET_TTL_MS) {
    this.sweeper = setInterval(() => this.sweep(), 30_000);
    this.sweeper.unref();
  }

  issue(userId: number, username: string): string {
    const ticket = randomUUID();
    this.tickets.set(ticket, { userId, username, expiresAt: Date.now() + this.ttlMs });
    return ticket;
  }

  consume(ticket: string): TicketInfo | null {
    const info = this.tickets.get(ticket);
    if (!info) return null;
    this.tickets.delete(ticket);
    if (Date.now() > info.expiresAt) return null;
    return info;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [ticket, info] of this.tickets) {
      if (now > info.expiresAt) this.tickets.delete(ticket);
    }
  }

  dispose(): void {
    clearInterval(this.sweeper);
    this.tickets.clear();
  }
}
