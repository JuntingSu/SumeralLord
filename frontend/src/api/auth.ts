import type { LoginResult } from '@dl/shared';
import { api } from './client';

export function register(username: string, password: string): Promise<void> {
  return api<void>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

export function login(username: string, password: string): Promise<LoginResult> {
  return api<LoginResult>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}
