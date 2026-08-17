import type { ApiEnvelope } from '@dl/shared';

const TOKEN_KEY = 'dl_token';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

/** 统一请求入口：注入 JWT、解析 { success, data, code, message } 包裹 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      // 无 body 的 POST（如退出房间）不能带 json Content-Type，否则服务端拒绝空体
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  let body: ApiEnvelope<T> | null = null;
  try {
    body = (await res.json()) as ApiEnvelope<T>;
  } catch {
    // 非 JSON 响应，按状态码报错
  }
  if (!res.ok || !body?.success) {
    throw new ApiError(res.status, body?.code ?? 'UNKNOWN', body?.message ?? `请求失败（${res.status}）`);
  }
  return body.data as T;
}
