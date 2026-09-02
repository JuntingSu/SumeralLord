import { create } from 'zustand';
import type { UserPublic } from '@dl/shared';
import { getToken, setToken } from '../api/client';

const USER_KEY = 'dl_user';

function loadUser(): UserPublic | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as UserPublic) : null;
  } catch {
    return null;
  }
}

interface AuthState {
  token: string | null;
  user: UserPublic | null;
  setAuth: (token: string, user: UserPublic) => void;
  /** 更新本地用户信息（个人资料修改 / 皮肤上传后）；可选携带重签 token */
  updateUser: (user: UserPublic, token?: string) => void;
  logout: () => void;
}

export const useAuth = create<AuthState>((set) => ({
  token: getToken(),
  user: loadUser(),
  setAuth: (token, user) => {
    setToken(token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    set({ token, user });
  },
  updateUser: (user, token) => {
    if (token) setToken(token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    set((s) => ({ ...s, user, ...(token ? { token } : {}) }));
  },
  logout: () => {
    setToken(null);
    localStorage.removeItem(USER_KEY);
    set({ token: null, user: null });
  },
}));
