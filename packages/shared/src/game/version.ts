// reducerVersion：对局演算契约版本。前后端共享同一默认值，环境变量可覆盖。
// 修改 reducer 行为时必须提升 REDUCER_VERSION，旧存档/旧客户端重连会因此被拒绝。

export const REDUCER_VERSION = 'dev-0.2.0';

export function reducerVersion(): string {
  const g = globalThis as { __DL_REDUCER_VERSION__?: string };
  return g.__DL_REDUCER_VERSION__ || REDUCER_VERSION;
}
