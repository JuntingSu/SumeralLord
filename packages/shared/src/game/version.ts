// reducerVersion：包版本 + git short sha（前端规划 §5.4 第 4 条）。
// 注入方式：后端启动时写 globalThis.__DL_REDUCER_VERSION__；前端由 vite define 注入同名全局。
// 未注入时回退 'dev-0.1.0'（本地开发：与后端 config 默认值对齐，保证重连校验一致）。

const FALLBACK = 'dev-0.1.0';

export function reducerVersion(): string {
  const g = globalThis as { __DL_REDUCER_VERSION__?: string };
  return g.__DL_REDUCER_VERSION__ ?? FALLBACK;
}
