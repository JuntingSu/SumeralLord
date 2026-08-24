import { api } from './client';
import type { MatchRecord, UserPublic } from '@dl/shared';

/** 本人最新公开信息（含 score/matches；统计展示用，避免登录缓存旧值） */
export function fetchMe(): Promise<{ user: UserPublic }> {
  return api<{ user: UserPublic }>('/api/users/me');
}

/** 本人对局记录（BM7b 战绩；M5.4 回放列表同源；每行含 scoreChanges 积分明细） */
export function fetchHistory(userId: number): Promise<{ history: MatchRecord[] }> {
  return api<{ history: MatchRecord[] }>(`/api/users/${userId}/history`);
}
