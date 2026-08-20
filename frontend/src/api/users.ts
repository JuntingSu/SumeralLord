import { api } from './client';
import type { MatchRecord } from '@dl/shared';

/** 本人对局记录（BM7b 战绩；M5.4 回放列表同源） */
export function fetchHistory(userId: number): Promise<{ history: MatchRecord[] }> {
  return api<{ history: MatchRecord[] }>(`/api/users/${userId}/history`);
}
