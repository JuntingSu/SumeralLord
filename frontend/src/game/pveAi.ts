// 普通 AI（MCTS）主线程客户端：按需创建 Worker，初始化后端下发的权重，按请求/响应规划整回合意图。
import type { GameState, PlayerIntent, PveWeightsResult } from '@dl/shared';

export interface PveAiPlanner {
  plan: (state: GameState, seat: number) => Promise<PlayerIntent[]>;
  dispose: () => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export async function createMctsPlanner(weights: PveWeightsResult['weights']): Promise<PveAiPlanner> {
  if (typeof Worker === 'undefined') throw new Error('当前浏览器不支持 Web Worker');
  const worker = new Worker(new URL('./pveAiWorker.ts', import.meta.url), { type: 'module' });
  const pending = new Map<number, Pending>();
  let seq = 0;
  let disposed = false;

  const failAll = (message: string): void => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
    }
    pending.clear();
  };

  worker.onmessage = (event: MessageEvent<{ id?: number; ok?: boolean; error?: string; intents?: PlayerIntent[] }>) => {
    const id = event.data?.id;
    if (typeof id !== 'number') return;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    if (event.data.ok) p.resolve(event.data.intents ?? []);
    else p.reject(new Error(event.data.error ?? 'MCTS Worker 规划失败'));
  };
  worker.onerror = () => failAll('MCTS Worker 运行错误');

  const request = <T>(message: Record<string, unknown>, timeoutMs: number): Promise<T> => {
    if (disposed) return Promise.reject(new Error('MCTS Worker 已关闭'));
    const id = ++seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('MCTS Worker 超时'));
      }, timeoutMs);
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      worker.postMessage({ ...message, id });
    });
  };

  await request({ type: 'init', weights }, 5000);

  return {
    plan: (state, seat) => request<PlayerIntent[]>({ type: 'plan', state, seat }, 15000),
    dispose: () => {
      disposed = true;
      failAll('MCTS Worker 已关闭');
      worker.terminate();
    },
  };
}
