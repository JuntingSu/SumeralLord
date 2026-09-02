import { api } from './client';
import type { MatchRecord, UserPublic } from '@dl/shared';

/** 本人最新公开信息（含 score/matches；统计展示用，避免登录缓存旧值） */
export function fetchMe(): Promise<{ user: UserPublic }> {
  return api<{ user: UserPublic }>('/api/users/me');
}

/** 修改用户名 / 密码（改密码需带 oldPassword 且正确）；改用户名时返回重签 token */
export interface UpdateProfileBody {
  username?: string;
  oldPassword?: string;
  newPassword?: string;
}

export function updateProfile(body: UpdateProfileBody): Promise<{ user: UserPublic; token?: string }> {
  return api<{ user: UserPublic; token?: string }>('/api/users/me', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

/** 上传一对个人皮肤 PNG（solid + hollow，192×216 base64 data URL） */
export function uploadSkin(solid: string, hollow: string): Promise<{ hasSkin: boolean }> {
  return api<{ hasSkin: boolean }>('/api/users/me/skin', {
    method: 'POST',
    body: JSON.stringify({ solid, hollow }),
  });
}

/** 本人对局记录（BM7b 战绩；M5.4 回放列表同源；每行含 scoreChanges 积分明细） */
export function fetchHistory(userId: number): Promise<{ history: MatchRecord[] }> {
  return api<{ history: MatchRecord[] }>(`/api/users/${userId}/history`);
}
