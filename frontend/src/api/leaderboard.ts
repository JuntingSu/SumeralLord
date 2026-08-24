import { api } from './client';
import type { LeaderboardResult } from '@dl/shared';

/** 排行榜（积分榜/对局数榜）：Top100 + 当前账号排名 */
export function fetchLeaderboard(type: 'score' | 'matches'): Promise<LeaderboardResult> {
  return api<LeaderboardResult>(`/api/leaderboard/${type}`);
}
