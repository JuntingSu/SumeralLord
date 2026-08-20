// 共识工具（前端规划 §4.2 / 规则 v2 §11.3）：
// reducer 演算到共识节点（FORCE_CLEAR / VICTORY）时立即上报（与动画解耦）；
// CONSENSUS_CONFIRMED 与本地演算比对，不一致按 CONSENSUS_MISMATCH 中止弹窗（诚实 bug 最后防线）。
import type { ConsensusPayload, GameEvent } from '@dl/shared';

export interface ConsensusNode {
  consensusId: string;
  payload: ConsensusPayload;
}

/** 从事件链提取共识节点，生成 consensusId：{触发意图eventId}:{nodeType}:{受影响seat} */
export function collectConsensusNodes(triggerEventId: number, chain: GameEvent[]): ConsensusNode[] {
  const nodes: ConsensusNode[] = [];
  for (const ev of chain) {
    if (ev.kind === 'FORCE_CLEAR') {
      nodes.push({
        consensusId: `${triggerEventId}:force_clear:${ev.seat}`,
        payload: { kind: 'FORCE_CLEAR', seat: ev.seat, reason: ev.reason },
      });
    } else if (ev.kind === 'VICTORY') {
      nodes.push({
        consensusId: `${triggerEventId}:victory:0`,
        payload: { kind: 'VICTORY', winningTeam: ev.winningTeam, winners: ev.winners, losers: ev.losers },
      });
    }
  }
  return nodes;
}

/** 本地演算结果与服务器确认比对（结构全等） */
export function sameConsensus(a: ConsensusPayload, b: ConsensusPayload): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
