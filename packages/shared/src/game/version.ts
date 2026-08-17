// reducerVersion：包版本 + git short sha（前端规划 §5.4 第 4 条）。
// 注入方式：后端启动时写 globalThis.__DL_REDUCER_VERSION__；前端由 vite define 注入同名全局。
// 未注入时回退 '0.1.0+dev'（本地纯逻辑测试场景）。

const FALLBACK = '0.1.0+dev';

export function reducerVersion(): string {
  const g = globalThis as { __DL_REDUCER_VERSION__?: string };
  return g.__DL_REDUCER_VERSION__ ?? FALLBACK;
}
