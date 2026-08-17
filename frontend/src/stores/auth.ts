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
  logout: () => {
    setToken(null);
    localStorage.removeItem(USER_KEY);
    set({ token: null, user: null });
  },
}));
