/// <reference lib="webworker" />
// PVE 普通 AI 的 MCTS Worker：权重由后端下发，主线程只传状态/座位，避免 2s 搜索阻塞 UI。
import { initMctsWeights, planMctsTurn } from '@dl/train';
import type { GameState, PlayerIntent } from '@dl/shared';

interface InitRequest {
  id: number;
  type: 'init';
  weights: { mid: number[]; late: number[] };
}

interface PlanRequest {
  id: number;
  type: 'plan';
  state: GameState;
  seat: number;
}

type Request = InitRequest | PlanRequest;

const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage: (message: unknown) => void;
};

ctx.onmessage = (event) => {
  const req = event.data;
  if (!req || typeof req !== 'object') return;
  try {
    if (req.type === 'init') {
      initMctsWeights(req.weights);
      ctx.postMessage({ id: req.id, ok: true });
      return;
    }
    if (req.type === 'plan') {
      const intents: PlayerIntent[] = planMctsTurn(req.state, req.seat, {
        simulations: 300,
        timeBudgetMs: 2000,
      });
      ctx.postMessage({ id: req.id, ok: true, intents });
    }
  } catch (err) {
    ctx.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
